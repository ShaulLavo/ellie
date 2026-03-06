/**
 * Traced chat wrapper — re-exports `chat` and `streamToText` from @ellie/ai
 * with transparent ALS-based trace instrumentation.
 *
 * When a HindsightTraceContext is active (set by the server's memory
 * controller via `hindsightTraceStore.run()`), each `chat()` call
 * emits start/end/error events through the context callback.
 *
 * When no context is active, `chat()` passes through to the raw
 * implementation with zero overhead.
 *
 * Internal Hindsight files import from this module instead of @ellie/ai
 * to get automatic trace instrumentation.
 */

import {
	chat as rawChat,
	streamToText
} from '@ellie/ai'
import type { AGUIEvent } from '@tanstack/ai'
import {
	hindsightTraceStore,
	type HindsightTraceContext
} from './trace-context'

export { streamToText }

/**
 * Traced drop-in replacement for `chat()` from @ellie/ai.
 *
 * All internal Hindsight callers use streaming mode (no schema, no
 * `stream: false`), so the return type is always `AsyncIterable<AGUIEvent>`.
 * When an ALS trace context is active, wraps the iterable to emit
 * timing events.
 */
export function chat(
	options: Parameters<typeof rawChat>[0]
): AsyncIterable<AGUIEvent> {
	const traceCtx = hindsightTraceStore.getStore()
	if (!traceCtx)
		return rawChat(options) as AsyncIterable<AGUIEvent>

	const startedAt = Date.now()
	traceCtx.onLLMCall({
		phase: 'start',
		startedAt,
		messageCount: options.messages?.length ?? 0,
		systemPromptCount:
			options.systemPrompts?.length ?? 0,
		hasTools: !!(options.tools?.length)
	})

	const source = rawChat(options) as AsyncIterable<AGUIEvent>
	return wrapWithTrace(source, startedAt, traceCtx)
}

async function* wrapWithTrace(
	source: AsyncIterable<AGUIEvent>,
	startedAt: number,
	ctx: HindsightTraceContext
): AsyncIterable<AGUIEvent> {
	let responseLength = 0
	try {
		for await (const chunk of source) {
			if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
				const delta = (
					chunk as unknown as { delta?: string }
				).delta
				responseLength += delta?.length ?? 0
			}
			yield chunk
		}
		ctx.onLLMCall({
			phase: 'end',
			startedAt,
			elapsedMs: Date.now() - startedAt,
			responseLength
		})
	} catch (err) {
		ctx.onLLMCall({
			phase: 'error',
			startedAt,
			elapsedMs: Date.now() - startedAt,
			error:
				err instanceof Error ? err.message : String(err)
		})
		throw err
	}
}
