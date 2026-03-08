import { sse } from 'elysia'
import type { AgentController } from '../agent/controller'
import type { RealtimeStore } from '../lib/realtime-store'
import {
	BadRequestError,
	ServiceUnavailableError
} from './http-errors'
import type { MessageInput } from './schemas/common-schemas'

// Re-export schemas for consumers that import from common.ts
export {
	messageInputSchema,
	type MessageInput,
	sessionParamsSchema,
	sessionRunParamsSchema,
	afterSeqQuerySchema,
	eventsQuerySchema,
	statusSchema
} from './schemas/common-schemas'

// ── Agent controller guard ───────────────────────────────────────────────────

const AGENT_UNAVAILABLE_ERROR =
	'Agent routes unavailable: no ANTHROPIC_API_KEY configured'

/**
 * Resolve the agent controller or throw a 503 ServiceUnavailableError.
 * Callers no longer need to check for `null` — the error is caught by
 * the global onError handler.
 */
export async function requireController(
	getAgentController: () => Promise<AgentController | null>
): Promise<AgentController> {
	const controller = await getAgentController()
	if (!controller) {
		throw new ServiceUnavailableError(
			AGENT_UNAVAILABLE_ERROR
		)
	}
	return controller
}

export { AGENT_UNAVAILABLE_ERROR }

// ── Session helpers ──────────────────────────────────────────────────────────

/** Resolve the virtual 'current' session ID to the actual one. */
export function resolveSessionId(
	store: RealtimeStore,
	raw: string
): string {
	return raw === 'current'
		? store.getCurrentSessionId()
		: raw
}

// ── Message helpers ──────────────────────────────────────────────────────────

export function normalizeMessageInput(
	body: MessageInput
): MessageInput {
	const content = body.content.trim()
	const hasAttachments =
		body.attachments && body.attachments.length > 0
	if (content.length === 0 && !hasAttachments) {
		throw new BadRequestError(
			`Missing 'content' field in request body`
		)
	}

	return {
		content,
		role: body.role,
		attachments: body.attachments,
		speechRef: body.speechRef
	}
}

export function parseAgentActionBody(body: {
	message: string
}): string {
	const value = normalizeMessageInput({
		content: body.message,
		role: undefined
	})

	return value.content
}

// ── SSE utilities ────────────────────────────────────────────────────────────

export interface SseState {
	activeClients: number
}

export function toStreamGenerator<
	TEvent extends { type: string }
>(
	request: Request,
	sseState: SseState,
	subscribe: (
		listener: (event: TEvent) => void
	) => () => void,
	mapEvent: (event: TEvent) => {
		event: string
		data: unknown
		close?: boolean
	},
	snapshotEvent: { event: string; data: unknown },
	initialEvents: TEvent[] = []
): AsyncGenerator<unknown> {
	const HEARTBEAT_MS = 30_000

	async function* streamGenerator() {
		sseState.activeClients++

		const queue: TEvent[] = [...initialEvents]
		let resolver: (() => void) | null = null
		let aborted = request.signal.aborted

		const wake = () => {
			if (!resolver) return
			resolver()
			resolver = null
		}

		const onAbort = () => {
			aborted = true
			wake()
		}

		request.signal.addEventListener('abort', onAbort, {
			once: true
		})
		const unsubscribe = subscribe(event => {
			queue.push(event)
			wake()
		})

		/** Wait for an item or heartbeat timeout, whichever comes first. */
		const waitForItemOrHeartbeat = () => {
			let timer: ReturnType<typeof setTimeout> | null = null
			return {
				promise: new Promise<'item' | 'heartbeat'>(
					resolve => {
						resolver = () => resolve('item')
						timer = setTimeout(
							() => resolve('heartbeat'),
							HEARTBEAT_MS
						)
					}
				),
				cleanup: () => {
					if (timer) clearTimeout(timer)
				}
			}
		}

		try {
			yield sse(snapshotEvent)

			while (!aborted) {
				if (queue.length === 0) {
					const waiter = waitForItemOrHeartbeat()
					const reason = await waiter.promise
					waiter.cleanup()
					if (reason === 'heartbeat' && !aborted) {
						yield sse({
							event: 'heartbeat',
							data: ''
						})
						continue
					}
				}
				if (aborted) break

				const next = queue.shift()
				if (!next) continue

				const mapped = mapEvent(next)
				yield sse({
					event: mapped.event,
					data: mapped.data
				})
				if (mapped.close) return
			}
		} finally {
			unsubscribe()
			request.signal.removeEventListener('abort', onAbort)
			sseState.activeClients = Math.max(
				0,
				sseState.activeClients - 1
			)
		}
	}

	return streamGenerator()
}
