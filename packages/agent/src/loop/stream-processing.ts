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
import { toModelMessages } from '../messages'
import { removeOrphans } from '../context-recovery'
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	ToolCall,
	ToolResultMessage
} from '../types'
import type {
	EmitFn,
	ProcessResult,
	StreamContext
} from './types'
import {
	shouldBlob,
	createTracedStreamFn,
	type BlobRef,
	type StreamCallOptions,
	type StreamFn
} from '@ellie/trace'
import {
	createPartial,
	emitTrace,
	emitUpdate
} from './helpers'
import {
	createToolCallTracker,
	wrapToolsForTanStack
} from './tool-bridge'

// ---------------------------------------------------------------------------
// Setup helpers — prepare inputs for the stream iteration
// ---------------------------------------------------------------------------

/** Apply context transform, sanitize orphans, convert to LLM messages. */
async function prepareMessages(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined
) {
	let messages = context.messages
	if (config.transformContext) {
		messages = await config.transformContext(
			[...messages],
			signal
		)
	}
	messages = removeOrphans(messages)
	return toModelMessages(messages)
}

/** Wire an external AbortSignal to a fresh AbortController. */
function createAbortBridge(
	signal: AbortSignal | undefined
) {
	if (!signal)
		return {
			abortController: undefined,
			cleanup: undefined
		}
	const abortController = new AbortController()
	const onAbort =
		abortController.abort.bind(abortController)
	signal.addEventListener('abort', onAbort, { once: true })
	const cleanup = () =>
		signal.removeEventListener('abort', onAbort)
	return { abortController, cleanup }
}

/** Build the AsyncIterable stream source from streamFn or chat(). */
function buildStreamSource(
	sctx: StreamContext,
	llmMessages: ReturnType<typeof toModelMessages>,
	tanStackTools:
		| ReturnType<typeof wrapToolsForTanStack>
		| undefined,
	abortController: AbortController | undefined
): AsyncIterable<StreamChunk> {
	const { config, streamFn } = sctx
	const systemPrompts = sctx.currentContext.systemPrompt
		? [sctx.currentContext.systemPrompt]
		: undefined
	const modelOptions =
		config.thinkingLevel && config.thinkingLevel !== 'off'
			? toThinkingModelOptions(
					config.model.provider,
					config.thinkingLevel
				)
			: undefined

	const shared = {
		adapter: config.adapter,
		messages: llmMessages,
		systemPrompts,
		tools: tanStackTools,
		modelOptions,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		abortController
	} as const

	// Build the effective stream function.
	// StreamFn / StreamCallOptions are structural bridges from @ellie/trace
	// that abstract over the generic TextActivityOptions from @tanstack/ai.
	let effectiveFn: StreamFn

	if (streamFn) {
		effectiveFn = streamFn as unknown as StreamFn
	} else {
		effectiveFn = ((opts: StreamCallOptions) =>
			chat({
				...opts,
				agentLoopStrategy: tanStackTools
					? maxIterations(config.maxTurns ?? 10)
					: () => false
			} as Parameters<typeof chat>[0])) as StreamFn
	}

	// Wrap with traced model facade when trace deps are available
	if (
		config.traceRecorder &&
		config.toolSafety?.traceScope
	) {
		effectiveFn = createTracedStreamFn(effectiveFn, {
			recorder: config.traceRecorder,
			blobSink: config.toolSafety.blobSink,
			parentScope: config.toolSafety.traceScope
		})
	}

	return effectiveFn(
		shared as StreamCallOptions
	) as AsyncIterable<StreamChunk>
}

// ---------------------------------------------------------------------------
// Iteration state — mutable bag carried through the for-await loop
// ---------------------------------------------------------------------------

interface IterationState {
	allMessages: AgentMessage[]
	partial: AssistantMessage
	emittedStart: boolean
	turnCount: number
	chunkCount: number
	partialJsonMap: Map<string, string>
	toolCallIndexMap: Map<string, number>
	rolling: { textIdx: number; thinkIdx: number }
}

function createIterationState(
	config: AgentLoopConfig
): IterationState {
	return {
		allMessages: [],
		partial: createPartial(config),
		emittedStart: false,
		turnCount: 0,
		chunkCount: 0,
		partialJsonMap: new Map(),
		toolCallIndexMap: new Map(),
		rolling: { textIdx: -1, thinkIdx: -1 }
	}
}

/** Reset per-turn state when a new LLM turn begins. */
function resetTurn(
	state: IterationState,
	config: AgentLoopConfig
): void {
	state.partial = createPartial(config)
	state.emittedStart = false
	state.partialJsonMap.clear()
	state.toolCallIndexMap.clear()
	state.rolling.textIdx = -1
	state.rolling.thinkIdx = -1
}

// ---------------------------------------------------------------------------
// Post-stream helpers
// ---------------------------------------------------------------------------

/** Mark the partial as an error if the model returned no content. */
function detectEmptyResponse(
	partial: AssistantMessage,
	config: AgentLoopConfig
): void {
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
}

/** Handle a caught stream error — mutates partial and emits trace. */
function handleStreamError(
	err: unknown,
	partial: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	chunkCount: number
): void {
	partial.stopReason = signal?.aborted ? 'aborted' : 'error'
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
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a full TanStack AI agent stream (may include multiple LLM turns
 * if tools are involved). Builds AssistantMessage + ToolResultMessage objects,
 * emits events for subscribers.
 */
export async function processAgentStream(
	sctx: StreamContext
): Promise<ProcessResult> {
	const {
		currentContext: context,
		config,
		signal,
		emit,
		loopDetector
	} = sctx

	// Prepare inputs
	const llmMessages = await prepareMessages(
		context,
		config,
		signal
	)
	const tracker = createToolCallTracker()
	const toolResultCollector: ToolResultMessage[] = []
	const tanStackTools = context.tools?.length
		? wrapToolsForTanStack(
				context.tools,
				tracker,
				signal,
				emit,
				toolResultCollector,
				config.toolSafety?.maxToolResultChars ?? 50_000,
				loopDetector,
				config.toolSafety?.blobSink,
				config.toolSafety?.traceScope
			)
		: undefined
	const { abortController, cleanup } =
		createAbortBridge(signal)

	// Trace the full context being sent to the API
	// Emitted before buildStreamSource so prompt.snapshot precedes model.request
	const snapshotPayload = {
		systemPrompt: sctx.currentContext.systemPrompt,
		messages: llmMessages,
		tools: context.tools?.map(t => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters
		})),
		model: config.model.id,
		provider: config.model.provider,
		thinkingLevel: config.thinkingLevel,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		messageCount: llmMessages.length
	}

	if (
		config.traceRecorder &&
		config.toolSafety?.traceScope
	) {
		const scope = config.toolSafety.traceScope
		const serialized = JSON.stringify(snapshotPayload)
		let blobRefs: BlobRef[] | undefined
		let inlinePayload: Record<string, unknown> =
			snapshotPayload

		if (
			config.toolSafety.blobSink &&
			shouldBlob(serialized)
		) {
			try {
				const blobRef =
					await config.toolSafety.blobSink.write({
						traceId: scope.traceId,
						spanId: scope.spanId,
						role: 'prompt_snapshot',
						content: serialized,
						mimeType: 'application/json',
						ext: 'json'
					})
				blobRefs = [blobRef]
				// Keep a 2KB preview inline
				inlinePayload = {
					...snapshotPayload,
					messages: `[${llmMessages.length} messages — see blob]`,
					_preview: serialized.slice(0, 2048)
				}
			} catch (blobErr) {
				// Best-effort blob — fall through with full inline payload
				console.warn(
					'[stream-processing] prompt.snapshot blob write failed:',
					blobErr instanceof Error
						? blobErr.message
						: String(blobErr)
				)
			}
		}

		config.traceRecorder.record(
			scope,
			'prompt.snapshot',
			'model',
			inlinePayload,
			blobRefs
		)
	} else {
		emitTrace(config, 'agent_context', snapshotPayload)
	}

	const streamSource = buildStreamSource(
		sctx,
		llmMessages,
		tanStackTools,
		abortController
	)

	// Iteration state
	const state = createIterationState(config)

	try {
		for await (const chunk of streamSource) {
			state.chunkCount++
			if (signal?.aborted) {
				state.partial.stopReason = 'aborted'
				state.partial.errorMessage = 'Request was aborted'
				break
			}

			// New LLM turn after tool execution
			if (
				chunk.type === 'RUN_STARTED' &&
				state.turnCount > 0
			) {
				if (
					state.emittedStart ||
					state.partial.content.length > 0
				) {
					finalizePartial(
						state.partial,
						state.emittedStart,
						context,
						state.allMessages,
						emit
					)
				}
				resetTurn(state, config)
			}

			if (chunk.type === 'TOOL_CALL_START') {
				tracker.register(chunk.toolCallId, chunk.toolName)
			}
			if (chunk.type === 'RUN_STARTED') {
				state.turnCount++
			}

			// Skip TanStack's post-execution event (results already handled by wrapper)
			if (
				chunk.type === 'TOOL_CALL_END' &&
				'result' in chunk &&
				chunk.result !== undefined
			) {
				flushToolResults(
					toolResultCollector,
					state.allMessages,
					context
				)
				continue
			}

			processChunk(chunk, state, emit, config)

			if (
				!state.emittedStart &&
				(chunk.type === 'RUN_STARTED' ||
					chunk.type === 'TEXT_MESSAGE_START' ||
					chunk.type === 'STEP_STARTED' ||
					chunk.type === 'TOOL_CALL_START')
			) {
				state.emittedStart = true
			}
		}
	} catch (err: unknown) {
		handleStreamError(
			err,
			state.partial,
			config,
			signal,
			state.chunkCount
		)
	} finally {
		cleanup?.()
	}

	detectEmptyResponse(state.partial, config)
	finalizePartial(
		state.partial,
		state.emittedStart,
		context,
		state.allMessages,
		emit
	)

	return {
		messages: state.allMessages,
		toolResults: toolResultCollector,
		lastAssistant: state.partial,
		abortedOrError:
			state.partial.stopReason === 'error' ||
			state.partial.stopReason === 'aborted'
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
	state: IterationState,
	emit: EmitFn,
	config: AgentLoopConfig
): void {
	const {
		partial,
		emittedStart,
		partialJsonMap,
		toolCallIndexMap,
		rolling
	} = state
	const { model } = config

	// Emit message_start once for any chunk that begins a new message turn
	const startsMessage =
		chunk.type === 'RUN_STARTED' ||
		chunk.type === 'TEXT_MESSAGE_START' ||
		chunk.type === 'STEP_STARTED' ||
		chunk.type === 'TOOL_CALL_START'
	if (!emittedStart && startsMessage) {
		emit({ type: 'message_start', message: { ...partial } })
	}

	switch (chunk.type) {
		case 'RUN_STARTED': {
			break
		}

		case 'TEXT_MESSAGE_START': {
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

		default:
			break
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
