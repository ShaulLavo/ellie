import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	type WASocket,
	type WAMessage
} from '@whiskeysockets/baileys'
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger'
import QRCode from 'qrcode'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import type { ChannelProvider } from '../../core/provider'
import type { ChannelManager } from '../../core/manager'
import type {
	ChannelAccountSettings,
	ChannelRuntimeStatus,
	ChannelDeliveryTarget
} from '../../core/types'
import {
	markdownToWhatsApp,
	chunkMessage
} from './formatting'

// ── Silent logger (satisfies Baileys ILogger without pino dep) ──────────────

const noop = () => {}
const silentLogger: ILogger = {
	level: 'silent',
	child() {
		return silentLogger
	},
	trace: noop,
	debug: noop,
	info: noop,
	warn: noop,
	error: noop
}

// ── WhatsApp-specific settings ──────────────────────────────────────────────

export interface WhatsAppSettings extends ChannelAccountSettings {
	/** 'self' = personal number (self-chat only), 'companion' = separate phone */
	phoneMode: 'self' | 'companion'
	/** Required for companion mode: owner's JID (e.g. "14155552671@s.whatsapp.net") */
	ownerJid?: string
}

// ── Per-account runtime state ───────────────────────────────────────────────

interface WhatsAppAccount {
	sock: WASocket | null
	settings: WhatsAppSettings
	status: ChannelRuntimeStatus
	/** True during loginStart — suppresses auto-reconnect on close */
	loggingIn: boolean
	/** Resolvers for the loginWait promise */
	loginResolve?: (value: unknown) => void
	loginReject?: (reason: unknown) => void
	/** Backoff state for reconnection */
	reconnectDelay: number
	reconnectTimer?: ReturnType<typeof setTimeout>
}

const MIN_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 60_000

/**
 * WhatsApp channel provider using Baileys.
 * Supports two phone modes:
 * - self: linked personal number, only self-chat messages accepted
 * - companion: separate linked phone, only owner's DMs accepted
 */
export class WhatsAppProvider implements ChannelProvider {
	readonly id = 'whatsapp'
	readonly displayName = 'WhatsApp'

	#manager: ChannelManager | null = null
	readonly #accounts = new Map<string, WhatsAppAccount>()

	// ── ChannelProvider lifecycle ────────────────────────────────────────

	async boot(manager: ChannelManager): Promise<void> {
		this.#manager = manager
		const accounts = manager.listSavedAccounts('whatsapp')
		for (const accountId of accounts) {
			const settings = manager.loadSettings(
				'whatsapp',
				accountId
			) as WhatsAppSettings | null
			if (!settings) continue
			// Only auto-connect if auth state exists (creds.json from a previous login)
			const authDir = join(
				manager.accountDir('whatsapp', accountId),
				'auth'
			)
			const hasCreds = existsSync(
				join(authDir, 'creds.json')
			)
			if (!hasCreds) continue
			try {
				await this.#connectAccount(accountId, settings)
			} catch (err) {
				console.error(
					`[whatsapp] Failed to boot account ${accountId}:`,
					err
				)
			}
		}
	}

	async shutdown(): Promise<void> {
		for (const [, account] of this.#accounts) {
			if (account.reconnectTimer) {
				clearTimeout(account.reconnectTimer)
			}
			if (account.sock) {
				account.sock.end(undefined)
			}
			account.status = { state: 'disconnected' }
		}
		this.#accounts.clear()
	}

	getStatus(accountId: string): ChannelRuntimeStatus {
		const account = this.#accounts.get(accountId)
		return account?.status ?? { state: 'disconnected' }
	}

	async loginStart(
		accountId: string,
		settings: ChannelAccountSettings
	): Promise<unknown> {
		const waSettings = settings as WhatsAppSettings

		// Disconnect existing account if any
		const existing = this.#accounts.get(accountId)
		if (existing) {
			if (existing.reconnectTimer) {
				clearTimeout(existing.reconnectTimer)
			}
			if (existing.sock) {
				existing.sock.end(undefined)
			}
			this.#accounts.delete(accountId)
		}

		// Clear auth so Baileys starts fresh with a QR (not stale creds)
		if (this.#manager) {
			const authDir = join(
				this.#manager.accountDir('whatsapp', accountId),
				'auth'
			)
			if (existsSync(authDir)) {
				rmSync(authDir, { recursive: true, force: true })
			}
		}

		// Set up account state with a pending QR promise
		const account: WhatsAppAccount = {
			sock: null,
			settings: waSettings,
			status: { state: 'connecting' },
			loggingIn: true,
			reconnectDelay: MIN_RECONNECT_DELAY
		}
		this.#accounts.set(accountId, account)

		// Connect and wait for the first QR code (with timeout)
		try {
			const qr = await new Promise<string>(
				(resolve, reject) => {
					const timeout = setTimeout(() => {
						reject(
							new Error(
								'Timed out waiting for WhatsApp QR code. Check your network connection.'
							)
						)
					}, 20_000)

					this.#createSocket(accountId, account)
						.then(sock => {
							account.sock = sock

							// Listen for the first QR or connection result
							const onConnectionUpdate = (
								update: Record<string, unknown>
							) => {
								if (update.qr) {
									clearTimeout(timeout)
									sock.ev.off(
										'connection.update',
										onConnectionUpdate
									)
									resolve(update.qr as string)
								}
								if (update.connection === 'open') {
									clearTimeout(timeout)
									sock.ev.off(
										'connection.update',
										onConnectionUpdate
									)
									// Already connected (restored creds), no QR needed
									resolve('')
								}
								if (update.connection === 'close') {
									clearTimeout(timeout)
									sock.ev.off(
										'connection.update',
										onConnectionUpdate
									)
									reject(
										new Error(
											'WhatsApp connection failed. Try again.'
										)
									)
								}
							}
							sock.ev.on(
								'connection.update',
								onConnectionUpdate
							)
						})
						.catch(err => {
							clearTimeout(timeout)
							reject(err)
						})
				}
			)
			account.loggingIn = false
			const qrTerminal = qr
				? await QRCode.toString(qr, { type: 'utf8' })
				: ''
			return { qr, qrTerminal }
		} catch (err) {
			// Login failed — clean up so no reconnect loop persists
			if (account.reconnectTimer) {
				clearTimeout(account.reconnectTimer)
			}
			if (account.sock) {
				account.sock.end(undefined)
			}
			this.#accounts.delete(accountId)
			throw err
		}
	}

	async loginWait(accountId: string): Promise<unknown> {
		const account = this.#accounts.get(accountId)
		if (!account) {
			throw new Error(
				`No login in progress for account ${accountId}`
			)
		}

		// If already connected, return immediately
		if (account.status.state === 'connected') {
			return { ok: true, alreadyConnected: true }
		}

		// Wait for connection to open (5 min — give user time to scan)
		return new Promise((resolve, reject) => {
			account.loginResolve = resolve
			account.loginReject = reject

			const timeout = setTimeout(() => {
				account.loginResolve = undefined
				account.loginReject = undefined
				reject(new Error('Login timed out'))
			}, 5 * 60_000)

			// Store original resolve to clear timeout
			const origResolve = resolve
			account.loginResolve = (value: unknown) => {
				clearTimeout(timeout)
				origResolve(value)
			}
		})
	}

	async logout(accountId: string): Promise<void> {
		const account = this.#accounts.get(accountId)
		if (account) {
			if (account.reconnectTimer) {
				clearTimeout(account.reconnectTimer)
			}
			if (account.sock) {
				try {
					await account.sock.logout()
				} catch {
					// May fail if already disconnected
					account.sock.end(undefined)
				}
			}
			this.#accounts.delete(accountId)
		}
	}

	updateSettings(
		accountId: string,
		settings: ChannelAccountSettings
	): void {
		const account = this.#accounts.get(accountId)
		if (account) {
			account.settings = settings as WhatsAppSettings
		}
	}

	async sendMessage(
		target: ChannelDeliveryTarget,
		text: string
	): Promise<void> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) {
			throw new Error(
				`WhatsApp account ${target.accountId} not connected`
			)
		}

		const formatted = markdownToWhatsApp(text)
		const chunks = chunkMessage(formatted)

		for (const chunk of chunks) {
			await account.sock.sendMessage(
				target.conversationId,
				{ text: chunk }
			)
		}
	}

	// ── Internal: socket creation ───────────────────────────────────────

	async #createSocket(
		accountId: string,
		account: WhatsAppAccount
	): Promise<WASocket> {
		if (!this.#manager) {
			throw new Error('WhatsApp provider not booted')
		}

		const authDir = join(
			this.#manager.accountDir('whatsapp', accountId),
			'auth'
		)
		mkdirSync(authDir, { recursive: true })

		const { state, saveCreds } =
			await useMultiFileAuthState(authDir)

		const { version } = await fetchLatestBaileysVersion()

		const sock = makeWASocket({
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(
					state.keys,
					silentLogger
				)
			},
			version,
			logger: silentLogger,
			printQRInTerminal: false,
			browser: ['Ellie', 'server', '1.0'],
			syncFullHistory: false,
			markOnlineOnConnect: false
		})

		// Prevent unhandled WebSocket errors from crashing the process (Bun compat)
		const ws = sock.ws as unknown as {
			on?: (event: string, fn: (err: Error) => void) => void
		}
		if (typeof ws?.on === 'function') {
			ws.on('error', (err: Error) => {
				console.error(
					`[whatsapp] WebSocket error for ${accountId}:`,
					err
				)
			})
		}

		sock.ev.on('creds.update', saveCreds)

		sock.ev.on('connection.update', update => {
			this.#handleConnectionUpdate(
				accountId,
				account,
				update
			)
		})

		sock.ev.on('messages.upsert', event => {
			this.#handleMessagesUpsert(
				accountId,
				account,
				sock,
				event
			)
		})

		return sock
	}

	// ── Internal: connection lifecycle ───────────────────────────────────

	#handleConnectionUpdate(
		accountId: string,
		account: WhatsAppAccount,
		update: Record<string, unknown>
	): void {
		const { connection, lastDisconnect } = update as {
			connection?: string
			lastDisconnect?: {
				error?: Error
				date?: Date
			}
		}

		if (connection === 'open') {
			account.status = {
				state: 'connected',
				connectedAt: Date.now()
			}
			account.reconnectDelay = MIN_RECONNECT_DELAY
			console.log(
				`[whatsapp] Account ${accountId} connected`
			)

			// Resolve loginWait if pending
			if (account.loginResolve) {
				account.loginResolve({ ok: true })
				account.loginResolve = undefined
				account.loginReject = undefined
			}
		}

		if (connection === 'close') {
			// During loginStart, don't reconnect — loginStart handles its own cleanup
			if (account.loggingIn) return

			const statusCode = (lastDisconnect?.error as any)
				?.output?.statusCode as number | undefined

			if (statusCode === DisconnectReason.loggedOut) {
				// Logged out — clear auth state, don't reconnect
				console.log(
					`[whatsapp] Account ${accountId} logged out`
				)
				account.status = { state: 'disconnected' }
				account.sock = null

				// Clean auth dir
				if (this.#manager) {
					const authDir = join(
						this.#manager.accountDir('whatsapp', accountId),
						'auth'
					)
					if (existsSync(authDir)) {
						rmSync(authDir, {
							recursive: true,
							force: true
						})
					}
				}

				// Reject loginWait if pending
				if (account.loginReject) {
					account.loginReject(new Error('Logged out'))
					account.loginResolve = undefined
					account.loginReject = undefined
				}
			} else {
				// Reconnect with exponential backoff
				const reason =
					lastDisconnect?.error?.message ?? 'unknown'
				console.log(
					`[whatsapp] Account ${accountId} disconnected (${reason}), reconnecting in ${account.reconnectDelay}ms`
				)
				account.status = {
					state: 'connecting',
					detail: `Reconnecting (${reason})`
				}

				account.reconnectTimer = setTimeout(() => {
					this.#reconnect(accountId, account)
				}, account.reconnectDelay)
				account.reconnectDelay = Math.min(
					account.reconnectDelay * 2,
					MAX_RECONNECT_DELAY
				)
			}
		}
	}

	async #reconnect(
		accountId: string,
		account: WhatsAppAccount
	): Promise<void> {
		try {
			const sock = await this.#createSocket(
				accountId,
				account
			)
			account.sock = sock
		} catch (err) {
			console.error(
				`[whatsapp] Reconnect failed for ${accountId}:`,
				err
			)
			account.status = {
				state: 'error',
				error:
					err instanceof Error ? err.message : String(err)
			}
		}
	}

	async #connectAccount(
		accountId: string,
		settings: WhatsAppSettings
	): Promise<void> {
		const account: WhatsAppAccount = {
			sock: null,
			settings,
			status: { state: 'connecting' },
			loggingIn: false,
			reconnectDelay: MIN_RECONNECT_DELAY
		}
		this.#accounts.set(accountId, account)

		const sock = await this.#createSocket(
			accountId,
			account
		)
		account.sock = sock
	}

	// ── Internal: message handling ──────────────────────────────────────

	#handleMessagesUpsert(
		accountId: string,
		account: WhatsAppAccount,
		sock: WASocket,
		event: {
			messages: WAMessage[]
			type: string
		}
	): void {
		if (event.type !== 'notify') return

		for (const msg of event.messages) {
			const jid = msg.key.remoteJid
			if (!jid) continue

			// Ignore group messages
			if (jid.endsWith('@g.us')) continue
			// Ignore broadcast
			if (jid === 'status@broadcast') continue
			// Echo suppression: ignore own outgoing messages
			if (msg.key.fromMe) continue

			// Mode-based sender gating
			if (account.settings.phoneMode === 'self') {
				// Self mode: only accept from own JID (self-chat)
				const selfJid = sock.user?.id
				if (!selfJid || jid !== selfJid) continue
			} else if (
				account.settings.phoneMode === 'companion'
			) {
				// Companion mode: only accept from owner
				if (jid !== account.settings.ownerJid) continue
			}

			// Extract text content
			const text = this.#extractText(msg.message)
			if (!text) continue

			// Route to channel manager
			this.#manager
				?.ingestMessage({
					channelId: 'whatsapp',
					accountId,
					conversationId: jid,
					senderId: jid,
					senderName: msg.pushName ?? undefined,
					text,
					timestamp: Date.now()
				})
				.catch(err => {
					console.error(
						`[whatsapp] Failed to ingest message from ${jid}:`,
						err
					)
				})
		}
	}

	#extractText(
		message: WAMessage['message']
	): string | null {
		if (!message) return null

		// Direct text message
		if (typeof message.conversation === 'string') {
			return message.conversation
		}

		// Extended text (e.g. with link preview)
		if (message.extendedTextMessage?.text) {
			return message.extendedTextMessage.text
		}

		// Image/video/document with caption
		const caption =
			message.imageMessage?.caption ??
			message.videoMessage?.caption ??
			message.documentMessage?.caption
		if (caption) return caption

		return null
	}
}
