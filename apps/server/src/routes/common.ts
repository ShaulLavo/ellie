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
	if (content.length === 0) {
		throw new BadRequestError(
			`Missing 'content' field in request body`
		)
	}

	return {
		content,
		role: body.role
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
	return (async function* streamGenerator() {
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

		const waitForItem = () =>
			new Promise<void>(resolve => {
				resolver = resolve
			})

		try {
			yield sse(snapshotEvent)

			while (!aborted) {
				if (queue.length === 0) await waitForItem()
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
	})()
}
