/**
 * AsyncLocalStorage-based trace context for Hindsight internal LLM calls.
 *
 * When the server's memory controller sets up a trace context via
 * `hindsightTraceStore.run(ctx, fn)`, every `chat()` call inside
 * that async scope will emit trace events through the callback.
 *
 * When no context is active (HTTP routes, tests), the traced chat
 * wrapper falls through to the raw `chat()` with zero overhead.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface HindsightLLMEvent {
	phase: 'start' | 'end' | 'error'
	startedAt: number
	messageCount?: number
	systemPromptCount?: number
	hasTools?: boolean
	elapsedMs?: number
	responseLength?: number
	error?: string
}

export interface HindsightTraceContext {
	onLLMCall: (event: HindsightLLMEvent) => void
}

export const hindsightTraceStore =
	new AsyncLocalStorage<HindsightTraceContext>()
