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

import { ulid } from 'fast-ulid'
import { chat as rawChat, streamToText } from '@ellie/ai'
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

	const callId = ulid()
	const startedAt = Date.now()
	traceCtx.onLLMCall({
		phase: 'start',
		callId,
		startedAt,
		messageCount: options.messages?.length ?? 0,
		systemPromptCount: options.systemPrompts?.length ?? 0,
		hasTools: !!options.tools?.length,
		messages: options.messages ?? [],
		systemPrompts: options.systemPrompts ?? [],
		tools: serializeTools(options.tools),
		modelOptions: options.modelOptions
	})

	const source = rawChat(
		options
	) as AsyncIterable<AGUIEvent>
	return wrapWithTrace(source, callId, startedAt, traceCtx)
}

async function* wrapWithTrace(
	source: AsyncIterable<AGUIEvent>,
	callId: string,
	startedAt: number,
	ctx: HindsightTraceContext
): AsyncIterable<AGUIEvent> {
	let responseLength = 0
	const textParts: string[] = []
	const thinkingParts: string[] = []
	const toolCalls: Array<{
		toolCallId: string
		toolName: string
		argsJson: string
	}> = []
	const activeToolArgs = new Map<string, string>()

	try {
		for await (const chunk of source) {
			accumulateChunk(
				chunk,
				textParts,
				thinkingParts,
				toolCalls,
				activeToolArgs
			)
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
			callId,
			startedAt,
			elapsedMs: Date.now() - startedAt,
			responseLength,
			responseText: textParts.join(''),
			thinkingText: thinkingParts.join(''),
			toolCalls
		})
	} catch (err) {
		ctx.onLLMCall({
			phase: 'error',
			callId,
			startedAt,
			elapsedMs: Date.now() - startedAt,
			responseLength,
			responseText: textParts.join(''),
			thinkingText: thinkingParts.join(''),
			toolCalls,
			error:
				err instanceof Error ? err.message : String(err)
		})
		throw err
	}
}

function serializeTools(
	tools: Parameters<typeof rawChat>[0]['tools']
): Array<{
	name?: string
	description?: string
	parameters?: unknown
}> {
	if (!Array.isArray(tools)) return []
	return tools.map(tool => {
		const candidate = tool as unknown as Record<
			string,
			unknown
		>
		return {
			name:
				typeof candidate.name === 'string'
					? candidate.name
					: undefined,
			description:
				typeof candidate.description === 'string'
					? candidate.description
					: undefined,
			parameters: candidate.parameters
		}
	})
}

function accumulateChunk(
	chunk: AGUIEvent,
	textParts: string[],
	thinkingParts: string[],
	toolCalls: Array<{
		toolCallId: string
		toolName: string
		argsJson: string
	}>,
	activeToolArgs: Map<string, string>
): void {
	switch (chunk.type) {
		case 'TEXT_MESSAGE_CONTENT': {
			const delta = (chunk as unknown as { delta?: string })
				.delta
			if (delta) textParts.push(delta)
			return
		}
		case 'STEP_FINISHED': {
			const delta = (chunk as unknown as { delta?: string })
				.delta
			if (delta) thinkingParts.push(delta)
			return
		}
		case 'TOOL_CALL_START': {
			const toolCallId = (
				chunk as unknown as { toolCallId?: string }
			).toolCallId
			if (toolCallId) activeToolArgs.set(toolCallId, '')
			return
		}
		case 'TOOL_CALL_ARGS': {
			const toolCallId = (
				chunk as unknown as { toolCallId?: string }
			).toolCallId
			if (!toolCallId) return
			const delta =
				(chunk as unknown as { delta?: string }).delta ?? ''
			activeToolArgs.set(
				toolCallId,
				(activeToolArgs.get(toolCallId) ?? '') + delta
			)
			return
		}
		case 'TOOL_CALL_END': {
			const toolChunk = chunk as unknown as {
				toolCallId?: string
				toolName?: string
			}
			if (!toolChunk.toolCallId) return
			toolCalls.push({
				toolCallId: toolChunk.toolCallId,
				toolName: toolChunk.toolName ?? '',
				argsJson:
					activeToolArgs.get(toolChunk.toolCallId) ?? '{}'
			})
			activeToolArgs.delete(toolChunk.toolCallId)
		}
	}
}
