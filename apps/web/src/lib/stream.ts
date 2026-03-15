/**
 * Branch stream client — EventSource for SSE, eden for REST.
 *
 * Ellie's SSE protocol:
 *   1. Connect to GET /api/chat/branches/:branchId/events/sse?afterSeq=N
 *   2. Receive "snapshot" event with all existing events (after afterSeq)
 *   3. Receive "append" events for new events in real-time
 *   4. Receive "update" events for in-place row updates (streaming deltas)
 *
 * For REST operations (send message, clear), we use eden directly.
 */

import type { ConnectionState } from '@ellie/schemas/chat'
import type { EventType } from '@ellie/schemas/events'
import { env } from '@ellie/env/client'
import { eden } from './eden'

/** Raw event row from the server event store. */
export interface EventRow {
	id: number
	branchId: string
	seq: number
	runId: string | null
	type: EventType
	payload: string // JSON string
	dedupeKey: string | null
	createdAt: number
}

export interface StreamCallbacks {
	onSnapshot: (
		events: EventRow[],
		branchChanged: boolean,
		resolvedBranchId: string
	) => void
	onAppend: (event: EventRow) => void
	onUpdate: (event: EventRow) => void
	onStateChange: (state: ConnectionState) => void
	onError: (message: string) => void
}

export class StreamClient {
	private branchId: string
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
	private lastResolvedBranchId: string | null = null

	constructor(
		branchId: string,
		callbacks: StreamCallbacks
	) {
		this.branchId = branchId
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

	/** Reconnect SSE with a full snapshot (e.g. on visibility change) */
	resync(): void {
		if (this.disposed) return
		this.openSSE()
	}

	/** Send a user message with optional file attachments */
	async sendMessage(
		content: string,
		role?: 'user' | 'assistant' | 'system',
		attachments?: {
			uploadId: string
			mime: string
			size: number
			name: string
		}[],
		speechRef?: string
	): Promise<void> {
		const { error } = await eden.api.chat
			.branches({
				branchId: this.branchId
			})
			.messages.post({
				content,
				role,
				attachments:
					attachments && attachments.length > 0
						? attachments
						: undefined,
				speechRef
			})
		if (error) throw error
	}

	/** Clear branch (delete + recreate) */
	async clearBranch(): Promise<void> {
		const { error } = await eden.api.chat
			.branches({
				branchId: this.branchId
			})
			.clear.post()
		if (error) throw error
	}

	private openSSE(): void {
		this.closeSSE()

		// Always request a full snapshot (no afterSeq filter).
		this.lastSeq = 0

		const baseUrl = env.API_BASE_URL.replace(/\/$/, '')
		const url = `${baseUrl}/api/chat/branches/${this.branchId}/events/sse`
		const es = new EventSource(url)
		this.eventSource = es

		es.addEventListener('snapshot', event => {
			try {
				const data = JSON.parse(
					(event as MessageEvent).data
				) as {
					branchId: string
					events: EventRow[]
				}
				for (const ev of data.events) {
					this.updateLastSeq(ev.seq)
				}
				const branchChanged =
					this.lastResolvedBranchId !== null &&
					this.lastResolvedBranchId !== data.branchId
				this.lastResolvedBranchId = data.branchId
				this.callbacks.onSnapshot(
					data.events,
					branchChanged,
					data.branchId
				)
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

		es.addEventListener('update', event => {
			try {
				const ev = JSON.parse(
					(event as MessageEvent).data
				) as EventRow
				// No updateLastSeq — seq was set at INSERT time
				this.callbacks.onUpdate(ev)
			} catch (err) {
				console.error(
					'[stream] Failed to parse update event:',
					err
				)
			}
		})

		es.addEventListener('open', () => {
			this.reconnectAttempts = 0
			this.callbacks.onStateChange('connected')
		})

		es.addEventListener('error', () => {
			this.closeSSE()
			this.callbacks.onStateChange('connecting')
			this.scheduleReconnect()
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
