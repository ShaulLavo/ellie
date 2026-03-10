import type { EventStore } from '@ellie/db'
import type {
	RealtimeStore,
	SessionEvent
} from '../../lib/realtime-store'
import type { ChannelDeliveryTarget } from './types'
import type { ChannelProvider } from './provider'

function targetKey(t: ChannelDeliveryTarget): string {
	return `${t.channelId}:${t.accountId}:${t.conversationId}`
}

interface PendingDelivery {
	sessionId: string
	targets: Map<string, ChannelDeliveryTarget>
}

interface PendingRowEntry {
	sessionId: string
	target: ChannelDeliveryTarget
	createdAt: number
}

const PENDING_ROW_TTL = 10 * 60_000 // 10 minutes
const PENDING_ROW_MAX = 500

/**
 * In-memory registry that tracks channel-triggered runs and routes
 * assistant replies back through the originating channel provider.
 *
 * Supports multiple contributing external targets per run and
 * row-based pending binding for follow-up/queued messages whose
 * runId is not yet known.
 *
 * Only runs with channel contributors are registered here;
 * web/CLI runs never enter this registry.
 */
export class ChannelDeliveryRegistry {
	readonly #pending = new Map<string, PendingDelivery>()
	readonly #pendingByRow = new Map<
		number,
		PendingRowEntry
	>()
	readonly #store: RealtimeStore
	readonly #getProvider: (
		id: string
	) => ChannelProvider | undefined
	readonly #watchedSessions = new Set<string>()
	readonly #unsubscribers: Array<() => void> = []

	constructor(opts: {
		store: RealtimeStore
		getProvider: (id: string) => ChannelProvider | undefined
	}) {
		this.#store = opts.store
		this.#getProvider = opts.getProvider
	}

	/** Register a delivery target for a channel-triggered run. Additive — multiple targets per run are supported. */
	register(
		runId: string,
		sessionId: string,
		target: ChannelDeliveryTarget
	): void {
		const key = targetKey(target)
		const existing = this.#pending.get(runId)
		if (existing) {
			existing.targets.set(key, target)
		} else {
			this.#pending.set(runId, {
				sessionId,
				targets: new Map([[key, target]])
			})
		}
	}

	/**
	 * Register a delivery target against a user_message row whose runId
	 * is not yet known (follow-up or queued path). When the row's runId
	 * is backfilled via updateEventRunId, the target is auto-promoted
	 * to a run-level registration.
	 */
	registerPending(
		rowId: number,
		sessionId: string,
		target: ChannelDeliveryTarget
	): void {
		this.#pendingByRow.set(rowId, {
			sessionId,
			target,
			createdAt: Date.now()
		})
		this.#sweepStalePending()
	}

	/** Remove stale pending entries that were never promoted. */
	#sweepStalePending(): void {
		if (this.#pendingByRow.size <= PENDING_ROW_MAX) return
		const now = Date.now()
		for (const [rowId, entry] of this.#pendingByRow) {
			if (now - entry.createdAt > PENDING_ROW_TTL) {
				this.#pendingByRow.delete(rowId)
			}
		}
	}

	/** Subscribe to a session's events for run_closed detection and runId backfill. Idempotent per sessionId. */
	watchSession(sessionId: string): void {
		if (this.#watchedSessions.has(sessionId)) return
		this.#watchedSessions.add(sessionId)

		const unsub = this.#store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				// runId backfill on a pending row → promote to run-level
				if (event.type === 'update') {
					const row = event.event
					if (!row.runId) return
					const pending = this.#pendingByRow.get(row.id)
					if (!pending) return
					this.#pendingByRow.delete(row.id)
					this.register(
						row.runId,
						pending.sessionId,
						pending.target
					)
					return
				}

				// run_closed → deliver
				if (event.type !== 'append') return
				if (event.event.type !== 'run_closed') return
				const runId = event.event.runId
				if (!runId) return
				this.#handleRunClosed(runId, sessionId).catch(
					err => {
						console.error(
							'[delivery] handleRunClosed failed:',
							err
						)
					}
				)
			}
		)
		this.#unsubscribers.push(unsub)
	}

	async #handleRunClosed(
		runId: string,
		sessionId: string
	): Promise<void> {
		const delivery = this.#pending.get(runId)
		if (!delivery) return // Not a channel-triggered run
		this.#pending.delete(runId)

		const text = this.#extractFinalAssistantText(
			sessionId,
			runId
		)
		if (!text) return

		// Fan out to every distinct contributing target
		for (const target of delivery.targets.values()) {
			const provider = this.#getProvider(target.channelId)
			if (!provider) continue

			try {
				await provider.sendMessage(target, text)
				this.#markDelivered(sessionId, runId, target)
			} catch (err) {
				console.error(
					`[delivery] Failed to send reply via ${target.channelId}:`,
					err
				)
			}
		}
	}

	#extractFinalAssistantText(
		sessionId: string,
		runId: string
	): string | null {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)

		const texts: string[] = []
		for (const row of rows) {
			if (row.type !== 'assistant_message') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload)
			} catch {
				continue
			}
			if (parsed.streaming) continue
			const message = parsed.message as
				| {
						content?: Array<{
							type: string
							text?: string
						}>
				  }
				| undefined
			if (!message?.content) continue
			for (const block of message.content) {
				if (block.type === 'text' && block.text) {
					texts.push(block.text)
				}
			}
		}
		return texts.length > 0 ? texts.join('\n') : null
	}

	/** Persist a channel_delivered marker event (idempotent via dedupeKey). */
	#markDelivered(
		sessionId: string,
		runId: string,
		target: ChannelDeliveryTarget
	): void {
		try {
			this.#store.appendEvent(
				sessionId,
				'channel_delivered',
				{
					channelId: target.channelId,
					accountId: target.accountId,
					conversationId: target.conversationId,
					deliveredAt: Date.now()
				},
				runId,
				`channel_delivered:${runId}:${targetKey(target)}`
			)
		} catch (err) {
			console.warn(
				'[delivery] Failed to persist channel_delivered marker:',
				err
			)
		}
	}

	/**
	 * Recover channel runs that closed but were never delivered
	 * (e.g. server crashed before sendMessage completed).
	 * Safe to call multiple times — delivery markers are idempotent.
	 */
	async recoverUndelivered(
		eventStore: EventStore,
		maxAgeMs = 30 * 60_000
	): Promise<number> {
		const undelivered =
			eventStore.findUndeliveredChannelRuns(maxAgeMs)
		if (undelivered.length === 0) return 0

		console.log(
			`[delivery] Recovering ${undelivered.length} undelivered channel run(s)`
		)

		let recovered = 0
		for (const row of undelivered) {
			try {
				const target: ChannelDeliveryTarget = {
					channelId: row.channelId,
					accountId: row.accountId,
					conversationId: row.conversationId
				}

				const text =
					this.#extractFinalAssistantText(
						row.sessionId,
						row.runId
					)
				if (!text) {
					console.warn(
						`[delivery] No reply text for run ${row.runId}, skipping`
					)
					continue
				}

				const provider = this.#getProvider(
					target.channelId
				)
				if (!provider) {
					console.warn(
						`[delivery] Provider ${target.channelId} not available, skipping`
					)
					continue
				}

				await provider.sendMessage(target, text)
				this.#markDelivered(
					row.sessionId,
					row.runId,
					target
				)
				recovered++
			} catch (err) {
				console.error(
					`[delivery] Recovery failed for run ${row.runId}:`,
					err
				)
			}
		}

		console.log(
			`[delivery] Recovered ${recovered} delivery(ies)`
		)
		return recovered
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedSessions.clear()
		this.#pending.clear()
		this.#pendingByRow.clear()
	}
}
