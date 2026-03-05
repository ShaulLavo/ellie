/**
 * Stream processing — consumes TanStack AI stream, builds messages.
 */

import {
	chat,
	maxIterations,
	type StreamChunk
} from '@tanstack/ai'
import {
	mapTanStackUsage,
	toThinkingModelOptions
} from '@ellie/ai'
import type { Model } from '@ellie/ai'
import { toModelMessages } from '../messages'
import { removeOrphans } from '../context-recovery'
import type { ToolLoopDetector } from '../tool-loop-detection'
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
	StreamFn
} from '../types'
import type { EmitFn, ProcessResult } from './types'
import {
	createPartial,
	emitTrace,
	emitUpdate
} from './helpers'
import {
	createToolCallTracker,
	wrapToolsForTanStack
} from './tool-bridge'

/**
 * Process a full TanStack AI agent stream (may include multiple LLM turns
 * if tools are involved). Builds AssistantMessage + ToolResultMessage objects,
 * emits events for subscribers.
 */
export async function processAgentStream(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	streamFn?: StreamFn,
	loopDetector?: ToolLoopDetector
): Promise<ProcessResult> {
	// Apply context transform
	let messages = context.messages
	if (config.transformContext) {
		messages = await config.transformContext(
			[...messages],
			signal
		)
	}

	// Sanitize orphaned tool results/calls before sending to API.
	// Orphans can appear after error-retry rollbacks or process crashes.
	messages = removeOrphans(messages)

	// Convert to LLM-compatible messages
	const llmMessages = toModelMessages(messages)

	// Set up tool bridge
	const tracker = createToolCallTracker()
	const toolResultCollector: ToolResultMessage[] = []
	const maxToolResultChars =
		config.toolSafety?.maxToolResultChars ?? 50_000
	const tanStackTools = context.tools?.length
		? wrapToolsForTanStack(
				context.tools,
				tracker,
				signal,
				emit,
				toolResultCollector,
				maxToolResultChars,
				loopDetector
			)
		: undefined

	// Build model options
	const modelOptions =
		config.thinkingLevel && config.thinkingLevel !== 'off'
			? toThinkingModelOptions(
					config.model.provider,
					config.thinkingLevel
				)
			: undefined

	// Build abort controller — create a real one and wire external signal
	let abortController: AbortController | undefined
	let cleanupAbortListener: (() => void) | undefined
	if (signal) {
		abortController = new AbortController()
		const onAbort = () => abortController!.abort()
		signal.addEventListener('abort', onAbort, {
			once: true
		})
		cleanupAbortListener = () =>
			signal.removeEventListener('abort', onAbort)
	}

	// Use custom streamFn or chat() with TanStack's agent loop
	const streamSource: AsyncIterable<StreamChunk> = streamFn
		? streamFn({
				adapter: config.adapter,
				messages: llmMessages,
				systemPrompts: context.systemPrompt
					? [context.systemPrompt]
					: undefined,
				tools: tanStackTools,
				modelOptions,
				temperature: config.temperature,
				maxTokens: config.maxTokens,
				abortController
			})
		: chat({
				adapter: config.adapter,
				messages: llmMessages,
				systemPrompts: context.systemPrompt
					? [context.systemPrompt]
					: undefined,
				tools: tanStackTools,
				modelOptions,
				temperature: config.temperature,
				maxTokens: config.maxTokens,
				abortController,
				// Let TanStack handle tool-call iterations
				agentLoopStrategy: tanStackTools
					? maxIterations(config.maxTurns ?? 10)
					: () => false
			})

	// State for multi-turn message accumulation
	const allMessages: AgentMessage[] = []
	let partial: AssistantMessage = createPartial(config)
	let emittedStart = false
	let turnCount = 0
	const partialJsonMap = new Map<string, string>()
	const toolCallIndexMap = new Map<string, number>()
	let chunkCount = 0
	/** Rolling indices for current text/thinking blocks — avoids O(n) scans. */
	const rolling = { textIdx: -1, thinkIdx: -1 }

	try {
		for await (const chunk of streamSource) {
			chunkCount++
			if (signal?.aborted) {
				partial.stopReason = 'aborted'
				partial.errorMessage = 'Request was aborted'
				break
			}

			// Detect new LLM turn: RUN_STARTED after a previous turn completed
			// This happens when TanStack re-calls the LLM after tool execution
			if (chunk.type === 'RUN_STARTED' && turnCount > 0) {
				// Only finalize if the previous partial has meaningful content
				if (emittedStart || partial.content.length > 0) {
					finalizePartial(
						partial,
						emittedStart,
						context,
						allMessages,
						emit
					)
				}
				// Start fresh partial for new turn
				partial = createPartial(config)
				emittedStart = false
				partialJsonMap.clear()
				toolCallIndexMap.clear()
				rolling.textIdx = -1
				rolling.thinkIdx = -1
			}

			// Track tool call IDs for the bridge
			if (chunk.type === 'TOOL_CALL_START') {
				tracker.register(chunk.toolCallId, chunk.toolName)
			}

			// Track RUN_STARTED for turn counting
			if (chunk.type === 'RUN_STARTED') {
				turnCount++
			}

			// After TanStack executes a tool, it emits TOOL_CALL_END with result.
			// Our wrapped execute already emitted tool_execution_* events and created
			// ToolResultMessages. The TOOL_CALL_END with result is TanStack's own event
			// after our execute returns — we should skip it to avoid double-processing.
			if (
				chunk.type === 'TOOL_CALL_END' &&
				'result' in chunk &&
				chunk.result !== undefined
			) {
				// TanStack's post-execution event. Tool results already handled by wrapper.
				// Push tool results into context for next LLM call awareness
				flushToolResults(
					toolResultCollector,
					allMessages,
					context
				)
				continue
			}

			// Process chunk into partial AssistantMessage
			processChunk(
				chunk,
				partial,
				emit,
				emittedStart,
				partialJsonMap,
				toolCallIndexMap,
				config.model,
				config,
				rolling
			)

			// Update emittedStart after processing
			if (
				!emittedStart &&
				(chunk.type === 'RUN_STARTED' ||
					chunk.type === 'TEXT_MESSAGE_START' ||
					chunk.type === 'STEP_STARTED' ||
					chunk.type === 'TOOL_CALL_START')
			) {
				emittedStart = true
			}
		}
	} catch (err: unknown) {
		partial.stopReason = signal?.aborted
			? 'aborted'
			: 'error'
		partial.errorMessage =
			err instanceof Error ? err.message : String(err)
		emitTrace(config, 'agent_loop.stream_error', {
			chunkCount,
			stopReason: partial.stopReason,
			errorMessage: partial.errorMessage
		})
		console.error(
			`[agent-loop] processAgentStream CAUGHT ERROR after ${chunkCount} chunks: stopReason=${partial.stopReason} errorMessage=${partial.errorMessage}`
		)
	} finally {
		cleanupAbortListener?.()
	}

	// Detect empty response — model returned no content (likely a failed
	// tool-use attempt when no tools are defined in the API request).
	// Mark as error so the caller/client sees a meaningful failure.
	if (
		partial.content.length === 0 &&
		partial.stopReason !== 'error' &&
		partial.stopReason !== 'aborted'
	) {
		emitTrace(config, 'agent_loop.empty_response', {
			stopReason: partial.stopReason,
			contentParts: 0
		})
		console.warn(
			`[agent-loop] empty response detected (contentParts=0 stopReason=${partial.stopReason}) — marking as error`
		)
		partial.stopReason = 'error'
		partial.errorMessage =
			'Model returned an empty response. This can happen when a tool call was attempted but no tools are available.'
	}

	// Finalize last partial
	finalizePartial(
		partial,
		emittedStart,
		context,
		allMessages,
		emit
	)

	return {
		messages: allMessages,
		toolResults: toolResultCollector,
		lastAssistant: partial,
		abortedOrError:
			partial.stopReason === 'error' ||
			partial.stopReason === 'aborted'
	}
}

function finalizePartial(
	partial: AssistantMessage,
	emittedStart: boolean,
	context: AgentContext,
	allMessages: AgentMessage[],
	emit: EmitFn
): void {
	// Strip empty thinking blocks (created by STEP_STARTED but never populated)
	partial.content = partial.content.filter(
		c =>
			c.type !== 'thinking' ||
			(c.type === 'thinking' && c.text.trim().length > 0)
	)

	// After stripping, skip if there's no meaningful content
	// (but always persist error/aborted partials so the client sees the error)
	const hasContent = partial.content.length > 0
	const isErrorOrAborted =
		partial.stopReason === 'error' ||
		partial.stopReason === 'aborted'
	if (!emittedStart && !hasContent && !isErrorOrAborted) {
		return
	}

	if (!emittedStart) {
		emit({ type: 'message_start', message: { ...partial } })
	}
	context.messages.push(partial)
	allMessages.push(partial)
	emit({ type: 'message_end', message: partial })
}

/** Push any new tool results from the collector into context and allMessages. */
function flushToolResults(
	toolResultCollector: ToolResultMessage[],
	allMessages: AgentMessage[],
	context: AgentContext
): void {
	for (const tr of toolResultCollector) {
		if (allMessages.includes(tr)) continue
		context.messages.push(tr)
		allMessages.push(tr)
	}
}

/**
 * Process a single StreamChunk into the partial AssistantMessage.
 * Emits message_start/message_update events.
 */
function processChunk(
	chunk: StreamChunk,
	partial: AssistantMessage,
	emit: EmitFn,
	emittedStart: boolean,
	partialJsonMap: Map<string, string>,
	toolCallIndexMap: Map<string, number>,
	model: Model,
	config: AgentLoopConfig,
	rolling: { textIdx: number; thinkIdx: number }
): void {
	switch (chunk.type) {
		case 'RUN_STARTED': {
			if (!emittedStart) {
				emit({
					type: 'message_start',
					message: { ...partial }
				})
			}
			break
		}

		case 'TEXT_MESSAGE_START': {
			if (!emittedStart) {
				emit({
					type: 'message_start',
					message: { ...partial }
				})
			}
			rolling.textIdx = partial.content.length
			partial.content.push({ type: 'text', text: '' })
			emitUpdate(emit, partial, {
				type: 'text_start',
				contentIndex: rolling.textIdx
			})
			break
		}

		case 'TEXT_MESSAGE_CONTENT': {
			const tc = partial.content[rolling.textIdx]
			if (tc && tc.type === 'text') {
				tc.text += chunk.delta
				emitUpdate(emit, partial, {
					type: 'text_delta',
					contentIndex: rolling.textIdx,
					delta: chunk.delta
				})
			}
			break
		}

		case 'TEXT_MESSAGE_END': {
			if (rolling.textIdx >= 0) {
				emitUpdate(emit, partial, {
					type: 'text_end',
					contentIndex: rolling.textIdx
				})
			}
			break
		}

		case 'STEP_STARTED': {
			if (!emittedStart) {
				emit({
					type: 'message_start',
					message: { ...partial }
				})
			}
			rolling.thinkIdx = partial.content.length
			partial.content.push({
				type: 'thinking',
				text: ''
			})
			emitUpdate(emit, partial, {
				type: 'thinking_start',
				contentIndex: rolling.thinkIdx
			})
			break
		}

		case 'STEP_FINISHED': {
			const tc = partial.content[rolling.thinkIdx]
			if (tc && tc.type === 'thinking') {
				tc.text += chunk.delta
				emitUpdate(emit, partial, {
					type: 'thinking_delta',
					contentIndex: rolling.thinkIdx,
					delta: chunk.delta
				})
				emitUpdate(emit, partial, {
					type: 'thinking_end',
					contentIndex: rolling.thinkIdx
				})
			}
			break
		}

		case 'TOOL_CALL_START': {
			if (!emittedStart) {
				emit({
					type: 'message_start',
					message: { ...partial }
				})
			}
			const tcIdx = partial.content.length
			partial.content.push({
				type: 'toolCall',
				id: chunk.toolCallId,
				name: chunk.toolName,
				arguments: {}
			})
			toolCallIndexMap.set(chunk.toolCallId, tcIdx)
			partialJsonMap.set(chunk.toolCallId, '')
			emitUpdate(emit, partial, {
				type: 'toolcall_start',
				contentIndex: tcIdx
			})
			break
		}

		case 'TOOL_CALL_ARGS': {
			handleToolCallArgs(
				chunk,
				partial,
				emit,
				partialJsonMap,
				toolCallIndexMap
			)
			break
		}

		case 'TOOL_CALL_END': {
			handleToolCallEnd(
				chunk,
				partial,
				emit,
				partialJsonMap,
				toolCallIndexMap,
				config
			)
			break
		}

		case 'RUN_FINISHED': {
			if (chunk.finishReason === 'tool_calls') {
				partial.stopReason = 'toolUse'
			} else if (chunk.finishReason === 'length') {
				partial.stopReason = 'length'
			} else {
				partial.stopReason = 'stop'
			}
			if (chunk.usage) {
				partial.usage = mapTanStackUsage(model, {
					promptTokens: chunk.usage.promptTokens,
					completionTokens: chunk.usage.completionTokens,
					totalTokens: chunk.usage.totalTokens
				})
			}
			break
		}

		case 'RUN_ERROR': {
			partial.stopReason = 'error'
			partial.errorMessage =
				chunk.error?.message || 'Unknown error'
			break
		}
	}
}

/** Handle TOOL_CALL_ARGS: accumulate partial JSON, try to parse, emit delta. */
function handleToolCallArgs(
	chunk: StreamChunk & { type: 'TOOL_CALL_ARGS' },
	partial: AssistantMessage,
	emit: EmitFn,
	partialJsonMap: Map<string, string>,
	toolCallIndexMap: Map<string, number>
): void {
	const accum =
		(partialJsonMap.get(chunk.toolCallId) || '') +
		chunk.delta
	partialJsonMap.set(chunk.toolCallId, accum)

	const tcArgIdx = toolCallIndexMap.get(chunk.toolCallId)
	if (tcArgIdx === undefined) return

	try {
		const parsed = JSON.parse(accum)
		const tc = partial.content[tcArgIdx]
		if (tc && tc.type === 'toolCall') {
			tc.arguments = parsed
		}
	} catch {
		// Incomplete JSON — keep accumulating
	}
	emitUpdate(emit, partial, {
		type: 'toolcall_delta',
		contentIndex: tcArgIdx,
		delta: chunk.delta
	})
}

/** Handle TOOL_CALL_END: finalize tool call arguments, emit end event. */
function handleToolCallEnd(
	chunk: StreamChunk & { type: 'TOOL_CALL_END' },
	partial: AssistantMessage,
	emit: EmitFn,
	partialJsonMap: Map<string, string>,
	toolCallIndexMap: Map<string, number>,
	config: AgentLoopConfig
): void {
	const tcEndIdx = toolCallIndexMap.get(chunk.toolCallId)
	if (tcEndIdx === undefined) return

	const tc = partial.content[tcEndIdx]
	if (tc && tc.type === 'toolCall') {
		finalizeToolCallArgs(tc, chunk, partialJsonMap, config)
	}
	emitUpdate(emit, partial, {
		type: 'toolcall_end',
		contentIndex: tcEndIdx,
		toolCall: tc as ToolCall
	})
}

/** Parse and assign final arguments to a tool call content block. */
function finalizeToolCallArgs(
	tc: ToolCall,
	chunk: StreamChunk & { type: 'TOOL_CALL_END' },
	partialJsonMap: Map<string, string>,
	config: AgentLoopConfig
): void {
	if (chunk.input !== undefined) {
		tc.arguments = chunk.input as Record<string, unknown>
		return
	}

	const finalJson =
		partialJsonMap.get(chunk.toolCallId) || '{}'
	try {
		tc.arguments = JSON.parse(finalJson)
	} catch {
		emitTrace(config, 'agent_loop.tool_call_parse_error', {
			toolName: tc.name,
			toolCallId: chunk.toolCallId,
			payloadLength: finalJson?.length ?? 0
		})
		console.warn(
			`[agent-loop] TOOL_CALL_END: failed to parse args JSON for ${tc.name}, toolCallId=${chunk.toolCallId}, payloadLength=${finalJson?.length ?? 0}`
		)
		tc.arguments = {}
	}
}
