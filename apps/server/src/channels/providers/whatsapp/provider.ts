import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	downloadMediaMessage,
	type WASocket,
	type WAMessage,
	type AnyMessageContent
} from '@whiskeysockets/baileys'
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger'
import QRCode from 'qrcode'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { env } from '@ellie/env/server'
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
import {
	jidToE164,
	type JidToE164Options
} from './normalize'
import { checkInboundAccessControl } from './access-control'
import {
	resolveRequireMention,
	type WhatsAppGroupConfig
} from './group-config'
import {
	extractMentionedJids,
	extractReplyToSenderJid,
	checkBotMention
} from './mention-detection'
import { resolveMentionGating } from './mention-gating'
import {
	recordGroupHistory,
	buildContextText,
	type GroupHistoryEntry
} from './group-history'
import {
	extractText,
	extractMediaPlaceholder,
	extractLocationData,
	formatLocationText,
	describeReplyContext
} from './extract'
import { downloadInboundMedia } from './media-download'
import { saveInboundMedia } from './media-store'
import {
	createInboundDebouncer,
	type InboundDebouncer
} from './inbound-debounce'
import * as v from 'valibot'
import { whatsappSettingsSchema } from './settings-schema'

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

// ── WhatsApp-specific settings (aligned with openclaw) ──────────────────────

export type DmPolicy =
	| 'pairing'
	| 'allowlist'
	| 'open'
	| 'disabled'
export type GroupPolicy = 'allowlist' | 'open' | 'disabled'

export interface WhatsAppSettings extends ChannelAccountSettings {
	/** Is the bot running on the owner's personal WhatsApp number? */
	selfChatMode: boolean
	/** Who can DM the agent: 'pairing' (default), 'allowlist', 'open', 'disabled' */
	dmPolicy: DmPolicy
	/** E.164 numbers allowed to message the agent (e.g. ["+15551234567"]) */
	allowFrom: string[]
	/** Group message handling: 'open' (default), 'allowlist', or 'disabled' */
	groupPolicy: GroupPolicy
	/** E.164 numbers allowed to trigger in groups (used when groupPolicy: 'allowlist') */
	groupAllowFrom: string[]
	/** Per-group configuration keyed by group JID (use "*" for wildcard default) */
	groups: Record<string, WhatsAppGroupConfig>
	/** Max unmentioned group messages to buffer as context (default: 50, 0 disables) */
	historyLimit: number
	/** Whether to send read receipts (blue ticks) for processed messages (default: true) */
	sendReadReceipts: boolean
	/** Inbound debounce window in ms — batches rapid messages from same sender (default: 0 = disabled) */
	debounceMs: number
	/** Max inbound media file size in MB (default: 50) */
	mediaMaxMb: number
}

const SETTINGS_DEFAULTS: WhatsAppSettings = {
	selfChatMode: false,
	dmPolicy: 'pairing',
	allowFrom: [],
	groupPolicy: 'disabled',
	groupAllowFrom: [],
	groups: {},
	historyLimit: 50,
	sendReadReceipts: true,
	debounceMs: 0,
	mediaMaxMb: 50
}

/** Merge raw settings with defaults so every field is safe to access. */
export function withDefaults(
	raw: ChannelAccountSettings
): WhatsAppSettings {
	return {
		...SETTINGS_DEFAULTS,
		...raw
	} as WhatsAppSettings
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
	/** Baileys auth directory path (for LID reverse mapping lookups) */
	authDir: string
	/** Timestamp when connection was established — for pairing grace period */
	connectedAtMs: number | null
}

const MIN_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 60_000

function defaultStatus(): ChannelRuntimeStatus {
	return { state: 'disconnected', reconnectAttempts: 0 }
}

function resolveMessageId(
	result: unknown
): string | undefined {
	if (
		typeof result === 'object' &&
		result &&
		'key' in result
	) {
		return (
			String(
				(result as { key?: { id?: string } }).key?.id ?? ''
			) || undefined
		)
	}
	return undefined
}

/**
 * WhatsApp channel provider using Baileys.
 * Access control delegated to access-control.ts module.
 */
export class WhatsAppProvider implements ChannelProvider {
	readonly id = 'whatsapp'
	readonly displayName = 'WhatsApp'

	#manager: ChannelManager | null = null
	readonly #accounts = new Map<string, WhatsAppAccount>()
	readonly #groupHistories = new Map<
		string,
		GroupHistoryEntry[]
	>()
	readonly #debouncers = new Map<string, InboundDebouncer>()

	// ── ChannelProvider lifecycle ────────────────────────────────────────

	async boot(manager: ChannelManager): Promise<void> {
		this.#manager = manager
		const accounts = manager.listSavedAccounts('whatsapp')
		for (const accountId of accounts) {
			const raw = manager.loadSettings(
				'whatsapp',
				accountId
			)
			if (!raw) continue
			// Validate and fill defaults via Valibot schema
			const result = v.safeParse(
				whatsappSettingsSchema,
				raw
			)
			if (!result.success) {
				console.error(
					`[whatsapp] Invalid settings for ${accountId}, skipping:`,
					result.issues
				)
				continue
			}
			// Re-save with defaults filled in (backward compat for pre-validation files)
			const settings = withDefaults(result.output)
			manager.saveSettings('whatsapp', accountId, settings)
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
		for (const [, debouncer] of this.#debouncers) {
			debouncer.dispose()
		}
		this.#debouncers.clear()
		for (const [, account] of this.#accounts) {
			if (account.reconnectTimer) {
				clearTimeout(account.reconnectTimer)
			}
			if (account.sock) {
				account.sock.end(undefined)
			}
			account.status = defaultStatus()
		}
		this.#accounts.clear()
	}

	getStatus(accountId: string): ChannelRuntimeStatus {
		const account = this.#accounts.get(accountId)
		return account?.status ?? defaultStatus()
	}

	async loginStart(
		accountId: string,
		settings: ChannelAccountSettings
	): Promise<unknown> {
		const waSettings = withDefaults(settings)

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
		const authDir = this.#manager
			? join(
					this.#manager.accountDir('whatsapp', accountId),
					'auth'
				)
			: ''
		const account: WhatsAppAccount = {
			sock: null,
			settings: waSettings,
			status: {
				...defaultStatus(),
				state: 'connecting'
			},
			loggingIn: true,
			reconnectDelay: MIN_RECONNECT_DELAY,
			authDir,
			connectedAtMs: null
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
			account.settings = withDefaults(settings)
		}
	}

	async sendMessage(
		target: ChannelDeliveryTarget,
		text: string
	): Promise<{ messageId?: string }> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) {
			throw new Error(
				`WhatsApp account ${target.accountId} not connected`
			)
		}

		// Typing indicator before reply (matching openclaw)
		await account.sock
			.sendPresenceUpdate(
				'composing',
				target.conversationId
			)
			.catch(() => {})

		const formatted = markdownToWhatsApp(text)
		const chunks = chunkMessage(formatted)

		let lastMessageId: string | undefined
		for (const chunk of chunks) {
			const result = await account.sock.sendMessage(
				target.conversationId,
				{ text: chunk }
			)
			lastMessageId = resolveMessageId(result)
		}

		// Track outbound activity
		account.status = {
			...account.status,
			lastEventAt: Date.now()
		}

		return { messageId: lastMessageId }
	}

	async sendMedia(
		target: ChannelDeliveryTarget,
		text: string,
		media: {
			buffer: Buffer
			mimetype: string
			fileName?: string
		}
	): Promise<{ messageId?: string }> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) {
			throw new Error(
				`WhatsApp account ${target.accountId} not connected`
			)
		}

		const { buffer, mimetype, fileName } = media
		let payload: AnyMessageContent

		if (mimetype.startsWith('image/')) {
			payload = {
				image: buffer,
				caption: text || undefined,
				mimetype
			}
		} else if (mimetype.startsWith('audio/')) {
			payload = { audio: buffer, ptt: true, mimetype }
		} else if (mimetype.startsWith('video/')) {
			payload = {
				video: buffer,
				caption: text || undefined,
				mimetype
			}
		} else {
			payload = {
				document: buffer,
				fileName: fileName ?? 'file',
				caption: text || undefined,
				mimetype
			}
		}

		const result = await account.sock.sendMessage(
			target.conversationId,
			payload
		)

		account.status = {
			...account.status,
			lastEventAt: Date.now()
		}

		return { messageId: resolveMessageId(result) }
	}

	async sendPoll(
		target: ChannelDeliveryTarget,
		poll: {
			question: string
			options: string[]
			maxSelections?: number
		}
	): Promise<{ messageId?: string }> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) {
			throw new Error(
				`WhatsApp account ${target.accountId} not connected`
			)
		}

		const result = await account.sock.sendMessage(
			target.conversationId,
			{
				poll: {
					name: poll.question,
					values: poll.options,
					selectableCount: poll.maxSelections ?? 1
				}
			} as AnyMessageContent
		)

		account.status = {
			...account.status,
			lastEventAt: Date.now()
		}

		return { messageId: resolveMessageId(result) }
	}

	async sendReaction(
		target: ChannelDeliveryTarget,
		messageId: string,
		emoji: string,
		fromMe?: boolean
	): Promise<void> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) {
			throw new Error(
				`WhatsApp account ${target.accountId} not connected`
			)
		}

		await account.sock.sendMessage(target.conversationId, {
			react: {
				text: emoji,
				key: {
					remoteJid: target.conversationId,
					id: messageId,
					fromMe: fromMe ?? false
				}
			}
		} as AnyMessageContent)

		account.status = {
			...account.status,
			lastEventAt: Date.now()
		}
	}

	async sendComposing(
		target: ChannelDeliveryTarget
	): Promise<void> {
		const account = this.#accounts.get(target.accountId)
		if (!account?.sock) return
		await account.sock
			.sendPresenceUpdate(
				'composing',
				target.conversationId
			)
			.catch(() => {})
	}

	isReady(accountId: string): {
		ok: boolean
		reason: string
	} {
		const account = this.#accounts.get(accountId)
		if (!account) {
			return { ok: false, reason: 'account-not-found' }
		}
		if (!account.sock) {
			return { ok: false, reason: 'not-connected' }
		}
		if (account.status.state !== 'connected') {
			return {
				ok: false,
				reason: `state-${account.status.state}`
			}
		}
		return { ok: true, reason: 'ok' }
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
			const now = Date.now()
			account.connectedAtMs = now

			// Resolve self-id from live socket
			const sock = account.sock
			const jidOpts: JidToE164Options | undefined =
				account.authDir
					? { authDir: account.authDir }
					: undefined
			const selfJid = sock?.user?.id ?? undefined
			const selfE164 = selfJid
				? jidToE164(selfJid, jidOpts)
				: null

			account.status = {
				state: 'connected',
				connectedAt: now,
				reconnectAttempts: 0,
				lastConnectedAt: now,
				lastEventAt: now,
				selfId: selfE164 ?? selfJid ?? undefined,
				// Preserve existing diagnostic fields
				lastMessageAt: account.status.lastMessageAt,
				lastError: account.status.lastError
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
				account.status = {
					...account.status,
					state: 'disconnected',
					reconnectAttempts: 0,
					lastDisconnect: 'logged-out',
					lastEventAt: Date.now(),
					selfId: undefined
				}
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
			} else if (
				statusCode === DisconnectReason.connectionReplaced
			) {
				// Another session took over (e.g. hot reload) — stop quietly, keep auth
				console.log(
					`[whatsapp] Account ${accountId} replaced by another session, stopping`
				)
				account.status = {
					...account.status,
					state: 'disconnected',
					reconnectAttempts: 0,
					lastDisconnect: 'connection-replaced',
					lastEventAt: Date.now()
				}
				account.sock = null
			} else {
				// Reconnect with exponential backoff
				const reason =
					lastDisconnect?.error?.message ?? 'unknown'
				console.log(
					`[whatsapp] Account ${accountId} disconnected (${reason}), reconnecting in ${account.reconnectDelay}ms`
				)
				account.status = {
					...account.status,
					state: 'connecting',
					detail: `Reconnecting (${reason})`,
					reconnectAttempts:
						(account.status.reconnectAttempts ?? 0) + 1,
					lastDisconnect: reason,
					lastError: reason,
					lastEventAt: Date.now()
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
			const errorMsg =
				err instanceof Error ? err.message : String(err)
			console.error(
				`[whatsapp] Reconnect failed for ${accountId}:`,
				err
			)
			account.status = {
				...account.status,
				state: 'error',
				error: errorMsg,
				lastError: errorMsg,
				lastEventAt: Date.now()
			}
		}
	}

	async #connectAccount(
		accountId: string,
		settings: WhatsAppSettings
	): Promise<void> {
		const authDir = this.#manager
			? join(
					this.#manager.accountDir('whatsapp', accountId),
					'auth'
				)
			: ''
		const account: WhatsAppAccount = {
			sock: null,
			settings,
			status: {
				...defaultStatus(),
				state: 'connecting'
			},
			loggingIn: false,
			reconnectDelay: MIN_RECONNECT_DELAY,
			authDir,
			connectedAtMs: null
		}
		this.#accounts.set(accountId, account)

		const sock = await this.#createSocket(
			accountId,
			account
		)
		account.sock = sock
	}

	// ── Internal: message handling ──────────────────────────────────────

	#getDebouncer(
		accountId: string,
		account: WhatsAppAccount
	): InboundDebouncer {
		let debouncer = this.#debouncers.get(accountId)
		if (!debouncer) {
			debouncer = createInboundDebouncer({
				debounceMs: account.settings.debounceMs ?? 0,
				onFlush: msg =>
					this.#manager?.ingestMessage(msg) ??
					Promise.resolve()
			})
			this.#debouncers.set(accountId, debouncer)
		}
		return debouncer
	}

	async #handleMessagesUpsert(
		accountId: string,
		account: WhatsAppAccount,
		sock: WASocket,
		event: {
			messages: WAMessage[]
			type: string
		}
	): Promise<void> {
		// Accept both 'notify' (real-time) and 'append' (history/offline)
		if (event.type !== 'notify' && event.type !== 'append')
			return

		// Options for jidToE164: pass auth dir so @lid JIDs can be resolved
		// via Baileys' reverse mapping files (matching openclaw)
		const jidOpts: JidToE164Options | undefined =
			account.authDir
				? { authDir: account.authDir }
				: undefined

		for (const msg of event.messages) {
			const jid = msg.key.remoteJid
			if (!jid) continue

			// Always block broadcast (no log — too noisy)
			if (jid === 'status@broadcast') continue
			// Echo suppression: ignore own outgoing messages
			if (msg.key.fromMe) continue

			const isGroup = jid.endsWith('@g.us')

			// For groups, the actual sender is in msg.key.participant (not remoteJid which is the group JID)
			const participantJid =
				msg.key.participant ?? undefined
			const senderJid = isGroup
				? (participantJid ?? jid)
				: jid

			// Resolve sender E.164 (handles both @s.whatsapp.net and @lid via auth dir)
			const senderE164 = jidToE164(senderJid, jidOpts)

			const label = msg.pushName ?? senderE164 ?? senderJid

			// ── Access control (via dedicated module) ─────────────
			const selfE164 = sock.user?.id
				? jidToE164(sock.user.id, jidOpts)
				: null

			const messageTimestampMs = msg.messageTimestamp
				? Number(msg.messageTimestamp) * 1000
				: undefined

			const acResult = await checkInboundAccessControl({
				settings: account.settings,
				selfE164,
				senderE164,
				isGroup,
				pushName: msg.pushName ?? undefined,
				isFromMe: msg.key.fromMe ?? false,
				messageTimestampMs,
				connectedAtMs: account.connectedAtMs ?? undefined,
				remoteJid: jid,
				sendPairingReply: text =>
					sock.sendMessage(jid, { text }).then(() => {}),
				dataDir: this.#manager?.dataDir,
				accountId
			})

			if (!acResult.allowed) {
				console.log(
					`[whatsapp] Blocked ${isGroup ? 'group' : 'DM'} from ${label}`
				)
				continue
			}

			// ── Read receipts ─────────────────────────────────────
			const sendReceipts =
				account.settings.sendReadReceipts ?? true
			if (
				acResult.shouldMarkRead &&
				sendReceipts &&
				msg.key.id
			) {
				sock
					.readMessages([
						{
							remoteJid: jid,
							id: msg.key.id,
							participant: msg.key.participant ?? undefined,
							fromMe: false
						}
					])
					.catch(() => {})
			}

			// History/offline catch-up: marked read above, but don't trigger agent
			if (event.type === 'append') continue

			// ── Text extraction (unified pipeline) ────────────────
			let text = extractText(msg.message)

			// Location augmentation
			const location = extractLocationData(msg.message)
			const locationText = location
				? formatLocationText(location)
				: null
			if (locationText) {
				text = [text, locationText]
					.filter(Boolean)
					.join('\n')
					.trim()
			}

			// Media placeholder fallback (before STT — audio gets transcribed instead)
			if (!text && !msg.message?.audioMessage) {
				text = extractMediaPlaceholder(msg.message) ?? null
			}

			// Voice → STT (only when no text extracted and audio exists)
			if (!text && msg.message?.audioMessage) {
				try {
					text = await this.#transcribeAudio(msg)
				} catch (err) {
					console.error(
						`[whatsapp] Voice transcription failed for ${label}:`,
						err
					)
					// Fall back to media placeholder
					text = '<media:audio>'
				}
			}

			if (!text) continue

			// ── Quoted-message context ────────────────────────────
			const replyContext = describeReplyContext(
				msg.message,
				jidOpts
			)
			if (replyContext) {
				const quotedLabel =
					replyContext.senderE164 ?? replyContext.sender
				const quotedPreview =
					replyContext.body.length > 200
						? replyContext.body.slice(0, 200) + '…'
						: replyContext.body
				text = `[Replying to ${quotedLabel}: "${quotedPreview}"]\n${text}`
			}

			// ── Media download ────────────────────────────────────
			let mediaPath: string | undefined
			let mediaType: string | undefined
			let mediaFileName: string | undefined
			try {
				const media = await downloadInboundMedia(msg)
				if (media && this.#manager?.dataDir) {
					const maxBytes =
						(account.settings.mediaMaxMb ?? 50) *
						1024 *
						1024
					const saved = await saveInboundMedia({
						buffer: media.buffer,
						mimetype: media.mimetype,
						fileName: media.fileName,
						dataDir: this.#manager.dataDir,
						maxBytes
					})
					if (saved) {
						mediaPath = saved.path
						mediaType = media.mimetype
						mediaFileName = media.fileName
					}
				}
			} catch (err) {
				console.log(
					`[whatsapp] Inbound media download failed: ${err}`
				)
			}

			// ── Group mention gating ──────────────────────────────
			if (isGroup) {
				const groups = account.settings.groups ?? {}
				const requireMention = resolveRequireMention(
					groups,
					jid
				)

				const mentionedJids = extractMentionedJids(
					msg.message
				)
				const replyToSenderJid = extractReplyToSenderJid(
					msg.message
				)
				const selfJid = sock.user?.id ?? null

				const mentionCheck = checkBotMention({
					mentionedJids,
					selfJid,
					selfE164,
					replyToSenderJid,
					body: text,
					jidOpts
				})

				const gate = resolveMentionGating({
					requireMention,
					wasMentioned: mentionCheck.wasMentioned,
					implicitMention: mentionCheck.implicitMention
				})

				if (!gate.shouldProcess) {
					const historyLimit =
						account.settings.historyLimit ?? 50
					if (historyLimit > 0) {
						const senderLabel =
							msg.pushName && senderE164
								? `${msg.pushName} (${senderE164})`
								: (msg.pushName ?? senderE164 ?? senderJid)
						recordGroupHistory(
							this.#groupHistories,
							jid,
							{
								sender: senderLabel,
								body: text,
								timestamp: messageTimestampMs
							},
							historyLimit
						)
					}
					console.log(
						`[whatsapp] Group message stored for context (no mention) in ${jid}`
					)
					continue
				}

				// Bot was mentioned — prepend history context
				text = buildContextText(
					this.#groupHistories,
					jid,
					text
				)
			}

			console.log(
				`[whatsapp] Accepted ${isGroup ? 'group' : 'DM'} from ${label}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`
			)

			// Track inbound message in status
			account.status = {
				...account.status,
				lastMessageAt: Date.now(),
				lastEventAt: Date.now()
			}

			// Typing indicator — let sender know we're processing
			sock
				.sendPresenceUpdate('composing', jid)
				.catch(() => {})

			// Reuse timestamp computed for access control, fallback to server time
			const timestamp = messageTimestampMs ?? Date.now()

			// Route through debouncer → channel manager
			const dedupeKey = `${accountId}:${jid}:${senderJid}`
			const debouncer = this.#getDebouncer(
				accountId,
				account
			)
			debouncer.enqueue(dedupeKey, {
				channelId: 'whatsapp',
				accountId,
				conversationId: jid,
				senderId: senderE164 ?? senderJid,
				senderName: msg.pushName ?? undefined,
				text,
				externalId: msg.key.id ?? undefined,
				timestamp,
				mediaPath,
				mediaType,
				mediaFileName
			})
		}
	}

	// ── Internal: voice message transcription ──────────────────────────

	async #transcribeAudio(
		msg: WAMessage
	): Promise<string | null> {
		const buffer = (await downloadMediaMessage(
			msg,
			'buffer',
			{}
		)) as Buffer

		console.log(
			`[whatsapp] Downloaded voice: ${buffer.length} bytes`
		)

		// WhatsApp voice = OGG Opus → convert to WAV for STT
		const wavBuffer = await this.#oggToWav(buffer)

		console.log(
			`[whatsapp] Converted to WAV: ${wavBuffer.length} bytes`
		)

		const form = new FormData()
		form.append(
			'audio',
			new Blob([new Uint8Array(wavBuffer)], {
				type: 'audio/wav'
			}),
			'voice.wav'
		)

		const res = await fetch(
			`${env.STT_BASE_URL}/transcribe`,
			{
				method: 'POST',
				body: form,
				signal: AbortSignal.timeout(15_000)
			}
		)
		if (!res.ok) {
			const body = await res.text().catch(() => '')
			throw new Error(
				`STT responded ${res.status}: ${body}`
			)
		}

		const result = (await res.json()) as {
			text: string
			speech_detected: boolean
		}
		if (!result.speech_detected || !result.text?.trim()) {
			return null
		}
		return result.text.trim()
	}

	async #oggToWav(ogg: Buffer): Promise<Buffer> {
		// Write to temp file — ffmpeg can't write valid WAV headers
		// to a pipe (can't seek back for RIFF size field)
		const tmpIn = `/tmp/wa-voice-${Date.now()}.ogg`
		const tmpOut = `/tmp/wa-voice-${Date.now()}.wav`
		try {
			await Bun.write(tmpIn, new Uint8Array(ogg))

			const proc = Bun.spawn(
				[
					'ffmpeg',
					'-loglevel',
					'error',
					'-y',
					'-i',
					tmpIn,
					'-acodec',
					'pcm_s16le',
					'-ar',
					'16000',
					'-ac',
					'1',
					tmpOut
				],
				{ stderr: 'pipe' }
			)

			const stderrBuf = await new Response(
				proc.stderr
			).text()
			const exitCode = await proc.exited
			if (exitCode !== 0) {
				throw new Error(
					`ffmpeg exit ${exitCode}: ${stderrBuf.trim()}`
				)
			}

			const wavFile = Bun.file(tmpOut)
			if (!(await wavFile.exists())) {
				throw new Error('ffmpeg produced no output')
			}
			return Buffer.from(await wavFile.arrayBuffer())
		} finally {
			rmSync(tmpIn, { force: true })
			rmSync(tmpOut, { force: true })
		}
	}
}
