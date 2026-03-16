import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync
} from 'node:fs'
import { createReadStream } from 'node:fs'
import { join, extname } from 'node:path'
import { hash } from 'ohash'
import type { ChannelProvider } from './provider'
import type {
	ChannelAccountSettings,
	ChannelInboundMessage
} from './types'
import type { ChannelDeliveryRegistry } from './delivery-registry'
import type { RealtimeStore } from '../../lib/realtime-store'
import type { BranchRuntimeHost } from '../../agent/runtime'
import type { FileStore } from '@ellie/tus'
import { Upload } from '@ellie/tus'
import type { UserMessage } from '@ellie/schemas/agent'

interface ChannelManagerOptions {
	dataDir: string
	store: RealtimeStore
	getBranchRuntimeHost: (
		branchId: string
	) => Promise<BranchRuntimeHost | null>
	ensureBootstrap: (branchId: string, runId: string) => void
	deliveryRegistry: ChannelDeliveryRegistry
	uploadStore?: FileStore
}

/** Dedupe cache TTL — entries older than this are pruned */
const DEDUPE_TTL_MS = 20 * 60_000
/** Dedupe cache max entries — oldest are evicted when exceeded */
const DEDUPE_MAX_SIZE = 5_000

/**
 * Central channel orchestrator.
 * Holds the provider registry, persists/loads settings, and provides
 * the shared ingestion helper that all channel providers use.
 */
export class ChannelManager {
	readonly #providers = new Map<string, ChannelProvider>()
	readonly #dataDir: string
	readonly #store: RealtimeStore
	readonly #getBranchRuntimeHost: (
		branchId: string
	) => Promise<BranchRuntimeHost | null>
	readonly #ensureBootstrap: (
		branchId: string,
		runId: string
	) => void
	readonly #deliveryRegistry: ChannelDeliveryRegistry
	readonly #uploadStore?: FileStore
	/** In-memory dedupe cache with TTL + max-size eviction */
	readonly #seenDedupeKeys = new Map<string, number>()

	constructor(opts: ChannelManagerOptions) {
		this.#dataDir = opts.dataDir
		this.#store = opts.store
		this.#getBranchRuntimeHost = opts.getBranchRuntimeHost
		this.#ensureBootstrap = opts.ensureBootstrap
		this.#deliveryRegistry = opts.deliveryRegistry
		this.#uploadStore = opts.uploadStore
	}

	register(provider: ChannelProvider): void {
		this.#providers.set(provider.id, provider)
	}

	getProvider(id: string): ChannelProvider | undefined {
		return this.#providers.get(id)
	}

	listProviders(): ChannelProvider[] {
		return [...this.#providers.values()]
	}

	get dataDir(): string {
		return this.#dataDir
	}

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

	async loadSettings(
		channelId: string,
		accountId: string
	): Promise<ChannelAccountSettings | null> {
		const path = this.settingsPath(channelId, accountId)
		const file = Bun.file(path)
		if (!(await file.exists())) return null
		return (await file.json()) as ChannelAccountSettings
	}

	async saveSettings(
		channelId: string,
		accountId: string,
		settings: ChannelAccountSettings
	): Promise<void> {
		const dir = this.accountDir(channelId, accountId)
		mkdirSync(dir, { recursive: true })
		await Bun.write(
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

	/**
	 * Wait for all providers to be fully connected (sockets open).
	 * Used by crash recovery to avoid racing delivery before channels are ready.
	 */
	async waitForReady(timeoutMs?: number): Promise<void> {
		const results = await Promise.allSettled(
			[...this.#providers.values()]
				.filter(p => typeof p.waitForReady === 'function')
				.map(p => p.waitForReady!(timeoutMs))
		)
		for (const r of results) {
			if (r.status === 'rejected') {
				console.warn(
					'[channels] waitForReady partial failure:',
					r.reason
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

	async ingestMessage(
		msg: ChannelInboundMessage
	): Promise<void> {
		// Resolve thread via thread_channels attachment table first
		const conversationKey =
			msg.conversationId ??
			`${msg.channelId}:${msg.accountId}`
		const attachedThreadId =
			this.#store.eventStore.findActiveChannelThread(
				msg.channelId,
				msg.accountId,
				conversationKey
			)

		let branchId: string

		if (attachedThreadId) {
			// Channel already attached to a thread — use its first branch
			const branchList = this.#store.listBranches(
				attachedThreadId
			)
			if (branchList.length === 0) {
				throw new Error(
					`Attached thread ${attachedThreadId} has no branches`
				)
			}
			branchId = branchList[0]!.id
		} else {
			// No attachment — fall back to default assistant thread
			// and create the attachment row for future routing
			const assistant =
				this.#store.getDefaultAssistantThread()
			if (!assistant)
				throw new Error('No default assistant thread')
			branchId = assistant.branchId
			this.#store.eventStore.attachChannel(
				assistant.threadId,
				msg.channelId,
				msg.accountId,
				conversationKey
			)
		}

		this.#store.ensureBranch(branchId)

		// Dedupe key: use externalId (e.g. WhatsApp msg ID) when available,
		// otherwise fall back to content hash with a 2s window based on message timestamp
		const dedupeKey = msg.externalId
			? `channel_msg:${msg.channelId}:${msg.conversationId}:${msg.externalId}`
			: `channel_msg:${msg.channelId}:${msg.conversationId}:${Math.floor(msg.timestamp / 2000)}:${hash(msg.text)}`

		// Fast in-memory dedupe check with TTL (no DB round-trip for repeated messages)
		const now = Date.now()
		const existingTs = this.#seenDedupeKeys.get(dedupeKey)
		if (
			existingTs !== undefined &&
			now - existingTs < DEDUPE_TTL_MS
		)
			return
		this.#seenDedupeKeys.set(dedupeKey, now)
		this.#pruneDedupeCache(now)

		// Build content parts: text + media (if present)
		const contentParts: UserMessage['content'] = []
		let mediaIngested = false

		// Upload media to the upload store so it's persisted and
		// the agent can see images / the frontend can render them
		if (msg.mediaPath && this.#uploadStore) {
			try {
				const mediaPart = await this.#ingestMedia(
					msg.mediaPath,
					msg.mediaType ?? 'application/octet-stream',
					msg.mediaFileName
				)
				if (mediaPart) {
					contentParts.push(mediaPart)
					mediaIngested = true
				}
			} catch (err) {
				console.error(
					'[channels] Failed to ingest media:',
					err
				)
			}
		}

		// Add text part — strip <media:*> placeholder when media
		// was successfully ingested (the placeholder is redundant)
		let textContent = msg.text
		if (mediaIngested) {
			textContent = textContent
				.replace(/<media:\w+>/g, '')
				.trim()
		}
		if (textContent) {
			contentParts.push({
				type: 'text' as const,
				text: textContent
			})
		}

		// Ensure at least one part
		if (contentParts.length === 0) {
			contentParts.push({
				type: 'text' as const,
				text: msg.text || ''
			})
		}

		const row = this.#store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user' as const,
				content: contentParts,
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

		const controller =
			await this.#getBranchRuntimeHost(branchId)
		if (!controller) return

		const result = await controller.handleMessage(
			branchId,
			msg.text,
			row.id
		)

		this.#ensureBootstrap(branchId, result.runId)

		// Register delivery target so reply routes back through this channel
		const deliveryTarget = {
			channelId: msg.channelId,
			accountId: msg.accountId,
			conversationId: msg.conversationId,
			...(msg.mediaType && {
				inboundMediaType: msg.mediaType
			})
		}

		if (result.routed === 'prompt') {
			// Idle — runId is the actual answering run
			this.#deliveryRegistry.register(
				result.runId,
				branchId,
				deliveryTarget
			)
		} else if (result.routed === 'followUp') {
			// Same-branch follow-up — register pending only.
			// The drain run will backfill the runId and promote it.
			// (Don't register against activeRunId — that run may be
			// answering a different conversation's message.)
			this.#deliveryRegistry.registerPending(
				row.id,
				branchId,
				deliveryTarget
			)
		} else {
			// Queued cross-branch — bind when runId is backfilled
			this.#deliveryRegistry.registerPending(
				row.id,
				branchId,
				deliveryTarget
			)
		}

		// Ensure we're watching this branch for run completions + backfills
		this.#deliveryRegistry.watchBranch(branchId)
	}

	/**
	 * Copy a local media file into the upload store and return a
	 * content part the agent can consume (with base64 data for images).
	 */
	async #ingestMedia(
		mediaPath: string,
		mediaType: string,
		mediaFileName?: string
	): Promise<UserMessage['content'][number] | null> {
		const store = this.#uploadStore
		if (!store) return null
		const mediaFile = Bun.file(mediaPath)
		if (!(await mediaFile.exists())) {
			console.warn(
				`[channels] Media file not found: ${mediaPath}`
			)
			return null
		}

		const stats = { size: mediaFile.size }
		const ext =
			extname(mediaFileName ?? mediaPath) || '.bin'
		const uploadId = `channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`

		// Register in upload store
		await store.create(
			new Upload({
				id: uploadId,
				size: stats.size,
				offset: 0,
				metadata: {
					filename: mediaFileName ?? `media${ext}`,
					filetype: mediaType
				},
				creation_date: new Date().toISOString()
			})
		)

		// Write file data
		const readable = createReadStream(mediaPath)
		await store.write(readable, uploadId, 0)

		const filePath = join(store.directory, uploadId)
		const url = `/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`

		if (mediaType.startsWith('image/')) {
			// Read as base64 so the model can see the image
			const buf = await Bun.file(mediaPath).arrayBuffer()
			return {
				type: 'image',
				file: uploadId,
				url,
				mime: mediaType,
				size: stats.size,
				name: mediaFileName,
				path: filePath,
				data: Buffer.from(buf).toString('base64'),
				mimeType: mediaType
			}
		}

		if (mediaType.startsWith('audio/')) {
			return {
				type: 'audio',
				file: uploadId,
				url,
				mime: mediaType,
				size: stats.size,
				name: mediaFileName,
				path: filePath
			}
		}

		if (mediaType.startsWith('video/')) {
			return {
				type: 'video',
				file: uploadId,
				url,
				mime: mediaType,
				size: stats.size,
				name: mediaFileName,
				path: filePath
			}
		}

		return {
			type: 'file',
			file: uploadId,
			url,
			mime: mediaType,
			size: stats.size,
			name: mediaFileName,
			path: filePath
		}
	}

	#pruneDedupeCache(now: number): void {
		// TTL eviction
		const cutoff = now - DEDUPE_TTL_MS
		for (const [key, ts] of this.#seenDedupeKeys) {
			if (ts < cutoff) this.#seenDedupeKeys.delete(key)
		}
		// Size cap — evict oldest (Map iteration order = insertion order)
		if (this.#seenDedupeKeys.size > DEDUPE_MAX_SIZE) {
			const excess =
				this.#seenDedupeKeys.size - DEDUPE_MAX_SIZE
			let removed = 0
			for (const key of this.#seenDedupeKeys.keys()) {
				if (removed >= excess) break
				this.#seenDedupeKeys.delete(key)
				removed++
			}
		}
	}
}
