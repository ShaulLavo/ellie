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
	try {
		for await (const chunk of source) {
			// Intercept RUN_FINISHED to record usage
			if (chunk.type === 'RUN_FINISHED') {
				finished = true
				const usage = chunk.usage as
					| Record<string, number>
					| undefined
				const responsePayload: Record<string, unknown> = {
					finishReason: chunk.finishReason,
					promptTokens: usage?.promptTokens,
					completionTokens: usage?.completionTokens,
					totalTokens: usage?.totalTokens
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
