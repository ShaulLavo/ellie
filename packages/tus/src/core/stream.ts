/**
 * Stream pipeline and size-limiting for tus uploads.
 * Extracted from server.ts for locality and benchmarkability.
 */

import {
	Readable,
	PassThrough,
	Transform,
	type TransformCallback
} from 'node:stream'
import * as streamPromises from 'node:stream/promises'

import { ERRORS } from './constants'
import type { DataStore } from './data-store'
import type { CancellationContext } from './locker'
import type { Upload } from './upload'

// ── StreamLimiter ───────────────────────────────────────────────────────────

class StreamLimiter extends Transform {
	private maxSize: number
	private currentSize = 0

	constructor(maxSize: number) {
		super()
		this.maxSize = maxSize
	}

	_transform(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: TransformCallback
	): void {
		this.currentSize += chunk.length
		if (this.currentSize > this.maxSize) {
			callback(
				Object.assign(
					new Error(ERRORS.ERR_MAX_SIZE_EXCEEDED.body),
					{
						status_code:
							ERRORS.ERR_MAX_SIZE_EXCEEDED.status_code,
						body: ERRORS.ERR_MAX_SIZE_EXCEEDED.body
					}
				)
			)
		} else {
			callback(null, chunk)
		}
	}
}

// ── writeToStore ────────────────────────────────────────────────────────────

export function writeToStore(
	store: DataStore,
	webStream: ReadableStream | null,
	upload: Upload,
	maxFileSize: number,
	context: CancellationContext
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		if (context.signal.aborted) {
			reject(ERRORS.ABORTED)
			return
		}

		const proxy = new PassThrough()
		const nodeStream = webStream
			? Readable.fromWeb(
					webStream as unknown as import('node:stream/web').ReadableStream
				)
			: Readable.from([])

		nodeStream.on('error', (err: NodeJS.ErrnoException) => {
			// Silently ignore expected client disconnections
			if (
				err.code === 'ECONNRESET' ||
				err.code === 'ECONNABORTED' ||
				err.code === 'ERR_STREAM_PREMATURE_CLOSE'
			) {
				return
			}
			console.warn('[tus] unexpected stream error:', err)
		})

		const onAbort = () => {
			nodeStream.unpipe(proxy)
			if (!proxy.closed) proxy.end()
		}
		context.signal.addEventListener('abort', onAbort, {
			once: true
		})

		proxy.on('error', err => {
			nodeStream.unpipe(proxy)
			reject(
				err.name === 'AbortError' ? ERRORS.ABORTED : err
			)
		})

		streamPromises
			.pipeline(
				nodeStream.pipe(proxy),
				new StreamLimiter(maxFileSize),
				async s => {
					return store.write(
						s as StreamLimiter,
						upload.id,
						upload.offset
					)
				}
			)
			.then(resolve)
			.catch(reject)
			.finally(() => {
				context.signal.removeEventListener('abort', onAbort)
			})
	})
}

// ── calculateMaxBodySize ────────────────────────────────────────────────────

export function calculateMaxBodySize(
	req: Request,
	file: Upload,
	configuredMaxSize: number
): number {
	const length = Number.parseInt(
		req.headers.get('content-length') || '0',
		10
	)
	const offset = file.offset

	const hasContentLengthSet =
		req.headers.get('content-length') !== null
	const hasConfiguredMaxSizeSet = configuredMaxSize > 0

	if (file.sizeIsDeferred) {
		if (
			hasContentLengthSet &&
			hasConfiguredMaxSizeSet &&
			offset + length > configuredMaxSize
		) {
			throw ERRORS.ERR_SIZE_EXCEEDED
		}
		if (hasConfiguredMaxSizeSet) {
			return configuredMaxSize - offset
		}
		return Number.MAX_SAFE_INTEGER
	}

	if (offset + length > (file.size || 0)) {
		throw ERRORS.ERR_SIZE_EXCEEDED
	}

	if (hasContentLengthSet) return length
	return (file.size || 0) - offset
}
