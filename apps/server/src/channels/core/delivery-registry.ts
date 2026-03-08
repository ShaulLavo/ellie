import type {
	RealtimeStore,
	SessionEvent
} from '../../lib/realtime-store'
import type { ChannelDeliveryTarget } from './types'
import type { ChannelProvider } from './provider'

interface PendingDelivery {
	sessionId: string
	target: ChannelDeliveryTarget
}

/**
 * In-memory registry that tracks channel-triggered runs and routes
 * assistant replies back through the originating channel provider.
 *
 * Only runs initiated by a channel inbound message are registered here;
 * web/CLI runs never enter this registry.
 */
export class ChannelDeliveryRegistry {
	readonly #pending = new Map<string, PendingDelivery>()
	readonly #store: RealtimeStore
	readonly #getProvider: (
		id: string
	) => ChannelProvider | undefined
	readonly #watchedSessions = new Set<string>()
	readonly #unsubscribers: Array<() => void> = []

	constructor(opts: {
		store: RealtimeStore
		getProvider: (
			id: string
		) => ChannelProvider | undefined
	}) {
		this.#store = opts.store
		this.#getProvider = opts.getProvider
	}

	/** Register a delivery target for a channel-triggered run. */
	register(
		runId: string,
		sessionId: string,
		target: ChannelDeliveryTarget
	): void {
		this.#pending.set(runId, { sessionId, target })
	}

	/** Subscribe to a session's events for run_closed detection. Idempotent per sessionId. */
	watchSession(sessionId: string): void {
		if (this.#watchedSessions.has(sessionId)) return
		this.#watchedSessions.add(sessionId)

		const unsub = this.#store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				if (event.type !== 'append') return
				if (event.event.type !== 'run_closed') return
				const runId = event.event.runId
				if (!runId) return
				this.#handleRunClosed(runId, sessionId)
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

		const provider = this.#getProvider(
			delivery.target.channelId
		)
		if (!provider) return

		try {
			await provider.sendMessage(delivery.target, text)
		} catch (err) {
			console.error(
				`[delivery] Failed to send reply via ${delivery.target.channelId}:`,
				err
			)
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
			const parsed = JSON.parse(row.payload)
			if (parsed.streaming) continue
			const message = parsed.message
			if (!message?.content) continue
			for (const block of message.content) {
				if (block.type === 'text' && block.text) {
					texts.push(block.text)
				}
			}
		}
		return texts.length > 0 ? texts.join('\n') : null
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedSessions.clear()
		this.#pending.clear()
	}
}
