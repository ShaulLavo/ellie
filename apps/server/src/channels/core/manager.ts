import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync
} from 'node:fs'
import { join } from 'node:path'
import { hash } from 'ohash'
import type { ChannelProvider } from './provider'
import type {
	ChannelAccountSettings,
	ChannelInboundMessage
} from './types'
import type { ChannelDeliveryRegistry } from './delivery-registry'
import type { RealtimeStore } from '../../lib/realtime-store'
import type { AgentController } from '../../agent/controller'

export interface ChannelManagerOptions {
	dataDir: string
	store: RealtimeStore
	getAgentController: () => Promise<AgentController | null>
	ensureBootstrap: (sessionId: string) => void
	deliveryRegistry: ChannelDeliveryRegistry
}

/**
 * Central channel orchestrator.
 * Holds the provider registry, persists/loads settings, and provides
 * the shared ingestion helper that all channel providers use.
 */
export class ChannelManager {
	readonly #providers = new Map<string, ChannelProvider>()
	readonly #dataDir: string
	readonly #store: RealtimeStore
	readonly #getAgentController: () => Promise<AgentController | null>
	readonly #ensureBootstrap: (sessionId: string) => void
	readonly #deliveryRegistry: ChannelDeliveryRegistry

	constructor(opts: ChannelManagerOptions) {
		this.#dataDir = opts.dataDir
		this.#store = opts.store
		this.#getAgentController = opts.getAgentController
		this.#ensureBootstrap = opts.ensureBootstrap
		this.#deliveryRegistry = opts.deliveryRegistry
	}

	// ── Provider registry ─────────────────────────────────────────────

	register(provider: ChannelProvider): void {
		this.#providers.set(provider.id, provider)
	}

	getProvider(id: string): ChannelProvider | undefined {
		return this.#providers.get(id)
	}

	listProviders(): ChannelProvider[] {
		return [...this.#providers.values()]
	}

	// ── Settings persistence ──────────────────────────────────────────

	channelDir(channelId: string): string {
		return join(this.#dataDir, 'channels', channelId)
	}

	accountDir(channelId: string, accountId: string): string {
		return join(this.channelDir(channelId), accountId)
	}

	settingsPath(
		channelId: string,
		accountId: string
	): string {
		return join(
			this.accountDir(channelId, accountId),
			'settings.json'
		)
	}

	loadSettings(
		channelId: string,
		accountId: string
	): ChannelAccountSettings | null {
		const path = this.settingsPath(channelId, accountId)
		if (!existsSync(path)) return null
		return JSON.parse(readFileSync(path, 'utf8'))
	}

	saveSettings(
		channelId: string,
		accountId: string,
		settings: ChannelAccountSettings
	): void {
		const dir = this.accountDir(channelId, accountId)
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			this.settingsPath(channelId, accountId),
			JSON.stringify(settings, null, 2)
		)
	}

	deleteAccountData(
		channelId: string,
		accountId: string
	): void {
		const dir = this.accountDir(channelId, accountId)
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true })
		}
	}

	/** List accountId subdirs for a channel (e.g. ["default"]). */
	listSavedAccounts(channelId: string): string[] {
		const dir = this.channelDir(channelId)
		if (!existsSync(dir)) return []
		return readdirSync(dir, { withFileTypes: true })
			.filter(d => d.isDirectory())
			.map(d => d.name)
	}

	// ── Boot ──────────────────────────────────────────────────────────

	async bootAll(): Promise<void> {
		for (const provider of this.#providers.values()) {
			try {
				await provider.boot(this)
			} catch (err) {
				console.error(
					`[channels] Failed to boot ${provider.id}:`,
					err
				)
			}
		}
	}

	async shutdownAll(): Promise<void> {
		for (const provider of this.#providers.values()) {
			try {
				await provider.shutdown()
			} catch (err) {
				console.error(
					`[channels] Failed to shut down ${provider.id}:`,
					err
				)
			}
		}
	}

	// ── Ingestion (called by providers on inbound message) ────────────

	async ingestMessage(
		msg: ChannelInboundMessage
	): Promise<void> {
		const sessionId = this.#store.getCurrentSessionId()
		this.#store.ensureSession(sessionId)

		// Dedupe key: reject duplicate messages in the same ~2s window
		const dedupeWindow = Math.floor(Date.now() / 2000)
		const contentHash = hash(msg.text)
		const dedupeKey = `channel_msg:${msg.channelId}:${msg.conversationId}:${dedupeWindow}:${contentHash}`

		const beforeAppend = Date.now()
		const row = this.#store.appendEvent(
			sessionId,
			'user_message',
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: msg.text }
				],
				timestamp: msg.timestamp,
				source: {
					kind: msg.channelId,
					channelId: msg.channelId,
					accountId: msg.accountId,
					conversationId: msg.conversationId,
					senderId: msg.senderId,
					senderName: msg.senderName
				}
			},
			undefined,
			dedupeKey
		)

		// Dedupe hit: appendEvent returned an existing row
		if (row.createdAt < beforeAppend) return

		this.#ensureBootstrap(sessionId)

		const controller = await this.#getAgentController()
		if (!controller) {
			console.warn(
				'[channels] Agent not available, dropping inbound message'
			)
			return
		}

		const result = await controller.handleMessage(
			sessionId,
			msg.text,
			row.id
		)

		// Register delivery target so reply routes back through this channel
		this.#deliveryRegistry.register(
			result.runId,
			sessionId,
			{
				channelId: msg.channelId,
				accountId: msg.accountId,
				conversationId: msg.conversationId
			}
		)

		// Ensure we're watching this session for run completions
		this.#deliveryRegistry.watchSession(sessionId)
	}
}
