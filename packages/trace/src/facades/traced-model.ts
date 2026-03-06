/**
 * Traced model facade — wraps a stream function to emit
 * model.request / model.response / model.error trace events.
 *
 * Uses structural typing to avoid importing @ellie/agent types
 * (would create a circular dependency).
 */

import { createChildScope } from '../scope'
import { shouldBlob } from '../blob-sink'
import type {
	BlobRef,
	BlobSink,
	TraceScope
} from '../types'
import type { TraceRecorder } from '../recorder'

// Structural types matching the shapes from @ellie/agent and @tanstack/ai
// without importing them directly.

interface StreamCallOptions {
	messages: unknown[]
	systemPrompts?: string[]
	tools?: unknown[]
	modelOptions?: Record<string, unknown>
	temperature?: number
	maxTokens?: number
	abortController?: AbortController
	[key: string]: unknown
}

interface StreamChunk {
	type: string
	[key: string]: unknown
}

type StreamFn = (
	options: StreamCallOptions
) => AsyncIterable<StreamChunk>

export interface TracedModelOptions {
	recorder: TraceRecorder
	blobSink?: BlobSink
	parentScope: TraceScope
}

/**
 * Wrap a StreamFn so every invocation emits model.request and
 * model.response (or model.error) trace events.
 */
export function createTracedStreamFn(
	baseFn: StreamFn,
	opts: TracedModelOptions
): StreamFn {
	return (callOpts: StreamCallOptions) => {
		const scope = createChildScope(opts.parentScope)

		// Emit model.request
		const requestPayload: Record<string, unknown> = {
			messageCount: callOpts.messages?.length ?? 0,
			toolCount: callOpts.tools?.length ?? 0,
			temperature: callOpts.temperature,
			maxTokens: callOpts.maxTokens,
			hasSystemPrompts: !!callOpts.systemPrompts?.length
		}
		opts.recorder.record(
			scope,
			'model.request',
			'model',
			requestPayload
		)

		const baseIterable = baseFn(callOpts)
		return wrapAsyncIterable(baseIterable, scope, opts)
	}
}

/**
 * Wraps the AsyncIterable to intercept RUN_FINISHED and errors.
 */
async function* wrapAsyncIterable(
	source: AsyncIterable<StreamChunk>,
	scope: TraceScope,
	opts: TracedModelOptions
): AsyncIterable<StreamChunk> {
	let finished = false
	let errored = false

	// Accumulate response content from stream chunks
	let textParts: string[] = []
	let thinkingParts: string[] = []
	let toolCalls: Array<{
		toolCallId: string
		toolName: string
		argsJson: string
	}> = []
	let activeToolArgs = new Map<string, string>()
	let activeToolNames = new Map<string, string>()

	try {
		for await (const chunk of source) {
			// Accumulate response body content
			switch (chunk.type) {
				case 'TEXT_MESSAGE_CONTENT':
					textParts.push(chunk.delta as string)
					break
				case 'STEP_FINISHED':
					thinkingParts.push(chunk.delta as string)
					break
				case 'TOOL_CALL_START':
					activeToolArgs.set(chunk.toolCallId as string, '')
					activeToolNames.set(
						chunk.toolCallId as string,
						chunk.toolName as string
					)
					break
				case 'TOOL_CALL_ARGS':
					activeToolArgs.set(
						chunk.toolCallId as string,
						(activeToolArgs.get(
							chunk.toolCallId as string
						) ?? '') + (chunk.delta as string)
					)
					break
				case 'TOOL_CALL_END': {
					const tcId = chunk.toolCallId as string
					toolCalls.push({
						toolCallId: tcId,
						toolName:
							activeToolNames.get(tcId) ??
							(chunk.toolName as string),
						argsJson: activeToolArgs.get(tcId) ?? '{}'
					})
					activeToolArgs.delete(tcId)
					activeToolNames.delete(tcId)
					break
				}
			}

			// Handle RUN_ERROR — mark as errored so finally doesn't emit partial
			if (chunk.type === 'RUN_ERROR') {
				errored = true
				opts.recorder.record(
					scope,
					'model.error',
					'model',
					{
						error:
							(chunk.error as { message?: string })
								?.message ?? String(chunk)
					}
				)
				yield chunk
				break
			}

			// Intercept RUN_FINISHED to record usage + response body
			if (chunk.type === 'RUN_FINISHED') {
				finished = true
				const usage = chunk.usage as
					| Record<string, number>
					| undefined
				// Build response body from accumulated content
				const responseBody: Record<string, unknown> = {}
				const text = textParts.join('')
				if (text) responseBody.text = text
				const thinking = thinkingParts.join('')
				if (thinking) responseBody.thinking = thinking
				if (toolCalls.length > 0)
					responseBody.toolCalls = toolCalls

				const responsePayload: Record<string, unknown> = {
					finishReason: chunk.finishReason,
					promptTokens: usage?.promptTokens,
					completionTokens: usage?.completionTokens,
					totalTokens: usage?.totalTokens,
					responseBody
				}

				let blobRefs: BlobRef[] | undefined
				const responseStr = JSON.stringify(responsePayload)
				if (opts.blobSink && shouldBlob(responseStr)) {
					try {
						const ref = await opts.blobSink.write({
							traceId: scope.traceId,
							spanId: scope.spanId,
							role: 'model_response',
							content: responseStr,
							mimeType: 'application/json',
							ext: 'json'
						})
						blobRefs = [ref]
					} catch (blobErr) {
						console.warn(
							`[traced-model] response blob write failed (traceId=${scope.traceId}):`,
							blobErr instanceof Error
								? blobErr.message
								: String(blobErr)
						)
					}
				}

				opts.recorder.record(
					scope,
					'model.response',
					'model',
					responsePayload,
					blobRefs
				)

				// Reset accumulators for next turn
				textParts = []
				thinkingParts = []
				toolCalls = []
				activeToolArgs.clear()
				activeToolNames.clear()
			}

			yield chunk
		}
	} catch (err) {
		errored = true
		opts.recorder.record(scope, 'model.error', 'model', {
			error:
				err instanceof Error ? err.message : String(err)
		})
		throw err
	} finally {
		if (!finished && !errored) {
			opts.recorder.record(
				scope,
				'model.response',
				'model',
				{
					finishReason: 'partial',
					partial: true
				}
			)
		}
	}
}
