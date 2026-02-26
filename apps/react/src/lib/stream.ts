/**
 * Session stream client — EventSource for SSE, eden for REST.
 *
 * Ellie's SSE protocol:
 *   1. Connect to GET /chat/:sessionId/events/sse?afterSeq=N
 *   2. Receive "snapshot" event with all existing events (after afterSeq)
 *   3. Receive "append" events for new events in real-time
 *
 * For REST operations (send message, list sessions, clear), we use eden directly.
 */

import type { ConnectionState } from '@ellie/schemas/chat'
import { env } from '@ellie/env/client'
import { eden } from './eden'

/** Raw event row from the server event store. */
export interface EventRow {
	id: number
	sessionId: string
	seq: number
	runId: string | null
	type: string
	payload: string // JSON string
	dedupeKey: string | null
	createdAt: number
}

export interface StreamCallbacks {
	onSnapshot: (events: EventRow[]) => void
	onAppend: (event: EventRow) => void
	onStateChange: (state: ConnectionState) => void
	onError: (message: string) => void
}

export class StreamClient {
	private sessionId: string
	private callbacks: StreamCallbacks
	private eventSource: EventSource | null = null
	private lastSeq = 0
	private reconnectAttempts = 0
	private maxReconnectAttempts = 10
	private baseReconnectDelay = 1000
	private reconnectTimer: ReturnType<
		typeof setTimeout
	> | null = null
	private disposed = false

	constructor(
		sessionId: string,
		callbacks: StreamCallbacks
	) {
		this.sessionId = sessionId
		this.callbacks = callbacks
	}

	connect(): void {
		this.disposed = false
		this.callbacks.onStateChange('connecting')
		this.openSSE()
	}

	disconnect(): void {
		this.disposed = true
		this.clearReconnectTimer()
		this.closeSSE()
		this.callbacks.onStateChange('disconnected')
	}

	/** Update seq tracking after processing events */
	updateLastSeq(seq: number): void {
		if (seq > this.lastSeq) this.lastSeq = seq
	}

	/** Reconnect SSE from last known seq (e.g. on visibility change) */
	resync(): void {
		if (this.disposed) return
		this.openSSE()
	}

	/** Send a user message */
	async sendMessage(
		content: string,
		role?: 'user' | 'assistant' | 'system'
	): Promise<void> {
		const { error } = await eden
			.chat({
				sessionId: this.sessionId
			})
			.messages.post({ content, role })
		if (error) throw error
	}

	/** Clear session (delete + recreate) */
	async clearSession(): Promise<void> {
		const { error } = await eden
			.chat({
				sessionId: this.sessionId
			})
			.clear.post()
		if (error) throw error
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private openSSE(): void {
		this.closeSSE()

		const baseUrl = env.API_BASE_URL.replace(/\/$/, '')
		const url = `${baseUrl}/chat/${this.sessionId}/events/sse${this.lastSeq > 0 ? `?afterSeq=${this.lastSeq}` : ''}`
		const es = new EventSource(url)
		this.eventSource = es

		es.addEventListener('snapshot', event => {
			try {
				const events = JSON.parse(
					(event as MessageEvent).data
				) as EventRow[]
				for (const ev of events) {
					this.updateLastSeq(ev.seq)
				}
				this.callbacks.onSnapshot(events)
			} catch (err) {
				console.error(
					'[stream] Failed to parse snapshot:',
					err
				)
			}
		})

		es.addEventListener('append', event => {
			try {
				const ev = JSON.parse(
					(event as MessageEvent).data
				) as EventRow
				this.updateLastSeq(ev.seq)
				this.callbacks.onAppend(ev)
			} catch (err) {
				console.error(
					'[stream] Failed to parse append event:',
					err
				)
			}
		})

		es.addEventListener('open', () => {
			this.reconnectAttempts = 0
			this.callbacks.onStateChange('connected')
		})

		es.addEventListener('error', () => {
			if (es.readyState === EventSource.CLOSED) {
				this.eventSource = null
				this.callbacks.onStateChange('connecting')
				this.scheduleReconnect()
			}
		})
	}

	private closeSSE(): void {
		if (this.eventSource) {
			this.eventSource.close()
			this.eventSource = null
		}
	}

	private scheduleReconnect(): void {
		if (
			this.disposed ||
			this.reconnectAttempts >= this.maxReconnectAttempts
		) {
			if (!this.disposed) {
				this.callbacks.onStateChange('error')
			}
			return
		}

		const delay = Math.min(
			this.baseReconnectDelay * 2 ** this.reconnectAttempts,
			30_000
		)
		this.reconnectAttempts++

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, delay)
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}
}
