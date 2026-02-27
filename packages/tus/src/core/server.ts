/**
 * TusServer — core tus protocol handler operating on web Request/Response.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 *
 * Removes Node.js http.IncomingMessage/ServerResponse, srvx, GetHandler, and
 * event-emitter infrastructure. Keeps: method dispatch, header validation,
 * CORS, locking, context creation, error mapping.
 */

import {
	Readable,
	PassThrough,
	Transform,
	type TransformCallback
} from 'node:stream'
import * as streamPromises from 'node:stream/promises'

import {
	ERRORS,
	HEADERS,
	ALLOWED_HEADERS,
	ALLOWED_METHODS,
	MAX_AGE,
	TUS_RESUMABLE,
	TUS_VERSION
} from './constants'
import type { DataStore } from './data-store'
import type { CancellationContext, Locker } from './locker'
import { MemoryLocker } from './locker'
import * as Metadata from './metadata'
import { Upload } from './upload'
import { Uid } from './uid'
import { validateHeader } from './validator'

// ── Types ───────────────────────────────────────────────────────────────────

export type TusServerOptions = {
	path: string
	datastore: DataStore
	maxSize?: number
	relativeLocation?: boolean
	respectForwardedHeaders?: boolean
	locker?: Locker
	lockDrainTimeout?: number
	namingFunction?: (
		req: Request,
		metadata?: Record<string, string | null>
	) => string | Promise<string>
	onUploadCreate?: (
		req: Request,
		upload: Upload
	) => Promise<{ metadata?: Upload['metadata'] }>
	onUploadFinish?: (
		req: Request,
		upload: Upload
	) => Promise<{
		status_code?: number
		headers?: Record<string, string | number>
		body?: string
	}>
	onIncomingRequest?: (
		req: Request,
		uploadId: string
	) => Promise<void>
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const reExtractFileID = /([^/]+)\/?$/
const reForwardedHost = /host="?([^";]+)/
const reForwardedProto = /proto=(https?)/

function extractHostAndProto(
	headers: Headers,
	respect?: boolean
) {
	let proto: string | undefined
	let host: string | undefined

	if (respect) {
		const forwarded = headers.get('forwarded')
		if (forwarded) {
			host ??= reForwardedHost.exec(forwarded)?.[1]
			proto ??= reForwardedProto.exec(forwarded)?.[1]
		}

		const forwardHost = headers.get('x-forwarded-host')
		const forwardProto = headers.get('x-forwarded-proto')

		if (
			forwardProto === 'http' ||
			forwardProto === 'https'
		) {
			proto ??= forwardProto
		}
		host ??= forwardHost ?? undefined
	}

	host ??= headers.get('host') ?? 'localhost'
	proto ??= 'http'

	return { host, proto }
}

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

// ── TusServer ───────────────────────────────────────────────────────────────

export class TusServer {
	private store: DataStore
	private opts: Required<
		Pick<
			TusServerOptions,
			| 'path'
			| 'locker'
			| 'lockDrainTimeout'
			| 'relativeLocation'
			| 'respectForwardedHeaders'
			| 'maxSize'
		>
	> &
		TusServerOptions

	constructor(options: TusServerOptions) {
		this.store = options.datastore
		this.opts = {
			locker: new MemoryLocker(),
			lockDrainTimeout: 3000,
			relativeLocation: false,
			respectForwardedHeaders: false,
			maxSize: 0,
			...options
		}
	}

	get datastore(): DataStore {
		return this.store
	}

	async handle(req: Request): Promise<Response> {
		const context = this.createContext()
		const headers = new Headers()

		const onError = (
			error: {
				status_code?: number
				body?: string
				message?: string
			} & Record<string, unknown>
		) => {
			const status_code =
				error.status_code ??
				ERRORS.UNKNOWN_ERROR.status_code
			const body =
				error.body ??
				`${ERRORS.UNKNOWN_ERROR.body}${error.message ?? ''}\n`
			return this.writeResponse(
				context,
				headers,
				status_code,
				body
			)
		}

		try {
			// Tus-Resumable header required on all non-OPTIONS requests
			headers.set('Tus-Resumable', TUS_RESUMABLE)

			if (
				req.method !== 'OPTIONS' &&
				!req.headers.get('tus-resumable')
			) {
				return this.writeResponse(
					context,
					headers,
					412,
					'Tus-Resumable Required\n'
				)
			}

			// Validate tus headers
			if (req.method !== 'OPTIONS') {
				const invalidHeaders: string[] = []
				for (const [name, value] of req.headers.entries()) {
					if (
						name.toLowerCase() === 'content-type' &&
						req.method !== 'PATCH'
					) {
						continue
					}
					if (!validateHeader(name, value)) {
						invalidHeaders.push(name)
					}
				}
				if (invalidHeaders.length > 0) {
					return this.writeResponse(
						context,
						headers,
						400,
						`Invalid ${invalidHeaders.join(' ')}\n`
					)
				}
			}

			// CORS headers
			headers.set('Access-Control-Allow-Origin', '*')
			headers.set(
				'Access-Control-Expose-Headers',
				HEADERS.join(', ')
			)

			let response: Response
			switch (req.method) {
				case 'OPTIONS':
					response = this.handleOptions(headers)
					break
				case 'POST':
					response = await this.handlePost(
						req,
						context,
						headers
					)
					break
				case 'HEAD':
					response = await this.handleHead(
						req,
						context,
						headers
					)
					break
				case 'PATCH':
					response = await this.handlePatch(
						req,
						context,
						headers
					)
					break
				case 'DELETE':
					response = await this.handleDelete(
						req,
						context,
						headers
					)
					break
				default:
					response = this.writeResponse(
						context,
						headers,
						404,
						'Not found\n'
					)
			}
			return response
		} catch (e) {
			return onError(
				e as {
					status_code?: number
					body?: string
					message?: string
				}
			)
		}
	}

	cleanUpExpiredUploads(): Promise<number> {
		if (!this.store.hasExtension('expiration')) {
			throw ERRORS.UNSUPPORTED_EXPIRATION_EXTENSION
		}
		return this.store.deleteExpired()
	}

	// ── Method Handlers ───────────────────────────────────────────────────

	private handleOptions(headers: Headers): Response {
		const maxSize = this.opts.maxSize
		headers.set('Tus-Version', TUS_VERSION.join(','))
		if (this.store.extensions.length > 0) {
			headers.set(
				'Tus-Extension',
				this.store.extensions.join(',')
			)
		}
		if (maxSize) {
			headers.set('Tus-Max-Size', maxSize.toString())
		}
		headers.set(
			'Access-Control-Allow-Methods',
			ALLOWED_METHODS
		)
		headers.set(
			'Access-Control-Allow-Headers',
			ALLOWED_HEADERS
		)
		headers.set(
			'Access-Control-Max-Age',
			MAX_AGE.toString()
		)

		return new Response(null, { status: 204, headers })
	}

	private async handlePost(
		req: Request,
		context: CancellationContext,
		headers: Headers
	): Promise<Response> {
		const upload_length = req.headers.get('upload-length')
		const upload_defer_length = req.headers.get(
			'upload-defer-length'
		)
		const upload_metadata = req.headers.get(
			'upload-metadata'
		)

		if (
			upload_defer_length !== null &&
			!this.store.hasExtension('creation-defer-length')
		) {
			throw ERRORS.UNSUPPORTED_CREATION_DEFER_LENGTH_EXTENSION
		}

		if (
			(upload_length === null) ===
			(upload_defer_length === null)
		) {
			throw ERRORS.INVALID_LENGTH
		}

		let metadata: Record<string, string | null> | undefined
		if (upload_metadata) {
			try {
				metadata = Metadata.parse(upload_metadata)
			} catch {
				throw ERRORS.INVALID_METADATA
			}
		}

		const namingFn = this.opts.namingFunction ?? Uid.rand
		const id = await namingFn(req, metadata)

		const maxFileSize = this.opts.maxSize ?? 0
		if (
			upload_length &&
			maxFileSize > 0 &&
			Number.parseInt(upload_length, 10) > maxFileSize
		) {
			throw ERRORS.ERR_MAX_SIZE_EXCEEDED
		}

		if (this.opts.onIncomingRequest) {
			await this.opts.onIncomingRequest(req, id)
		}

		const upload = new Upload({
			id,
			size: upload_length
				? Number.parseInt(upload_length, 10)
				: undefined,
			offset: 0,
			metadata
		})

		if (this.opts.onUploadCreate) {
			const patch = await this.opts.onUploadCreate(
				req,
				upload
			)
			if (patch.metadata) {
				upload.metadata = patch.metadata
			}
		}

		const lock = await this.acquireLock(id, context)

		const responseData: {
			status: number
			headers: Record<string, string | number>
			body: string
		} = {
			status: 201,
			headers: Object.fromEntries(headers.entries()),
			body: ''
		}

		let isFinal: boolean
		let url: string

		try {
			await this.store.create(upload)
			url = this.generateUrl(req, upload.id)

			isFinal = upload.size === 0 && !upload.sizeIsDeferred

			// creation-with-upload: if Content-Type is valid, write the body
			if (
				validateHeader(
					'content-type',
					req.headers.get('content-type')
				)
			) {
				const bodyMaxSize = this.calculateMaxBodySize(
					req,
					upload,
					maxFileSize
				)
				const newOffset = await this.writeToStore(
					req.body,
					upload,
					bodyMaxSize,
					context
				)
				responseData.headers['Upload-Offset'] =
					newOffset.toString()
				isFinal =
					newOffset ===
					Number.parseInt(upload_length as string, 10)
				upload.offset = newOffset
			}
		} catch (e) {
			context.abort()
			throw e
		} finally {
			await lock.unlock()
		}

		if (isFinal && this.opts.onUploadFinish) {
			const patch = await this.opts.onUploadFinish(
				req,
				upload
			)
			if (patch.status_code)
				responseData.status = patch.status_code
			if (patch.body) responseData.body = patch.body
			if (patch.headers) {
				Object.assign(responseData.headers, patch.headers)
			}
		}

		// Expiration header
		if (
			this.store.hasExtension('expiration') &&
			this.store.getExpiration() > 0 &&
			upload.creation_date
		) {
			const created = await this.store.getUpload(upload.id)
			if (
				created.offset !==
				Number.parseInt(upload_length as string, 10)
			) {
				const creation = new Date(upload.creation_date)
				responseData.headers['Upload-Expires'] = new Date(
					creation.getTime() + this.store.getExpiration()
				).toUTCString()
			}
		}

		if (
			responseData.status === 201 ||
			(responseData.status >= 300 &&
				responseData.status < 400)
		) {
			responseData.headers.Location = url
		}

		return new Response(
			responseData.status === 204
				? null
				: responseData.body || null,
			{
				status: responseData.status,
				headers: responseData.headers as Record<
					string,
					string
				>
			}
		)
	}

	private async handleHead(
		req: Request,
		context: CancellationContext,
		headers: Headers
	): Promise<Response> {
		const id = this.getFileIdFromRequest(req)
		if (!id) throw ERRORS.FILE_NOT_FOUND

		if (this.opts.onIncomingRequest) {
			await this.opts.onIncomingRequest(req, id)
		}

		const lock = await this.acquireLock(id, context)
		let file: Upload
		try {
			file = await this.store.getUpload(id)
		} finally {
			await lock.unlock()
		}

		// Check expiration
		const now = new Date()
		if (
			this.store.hasExtension('expiration') &&
			this.store.getExpiration() > 0 &&
			file.creation_date &&
			now >
				new Date(
					new Date(file.creation_date).getTime() +
						this.store.getExpiration()
				)
		) {
			throw ERRORS.FILE_NO_LONGER_EXISTS
		}

		headers.set('Cache-Control', 'no-store')
		headers.set('Upload-Offset', file.offset.toString())

		if (file.sizeIsDeferred) {
			headers.set('Upload-Defer-Length', '1')
		} else {
			headers.set(
				'Upload-Length',
				(file.size as number).toString()
			)
		}

		if (file.metadata !== undefined) {
			headers.set(
				'Upload-Metadata',
				Metadata.stringify(file.metadata)
			)
		}

		return new Response('', { status: 200, headers })
	}

	private async handlePatch(
		req: Request,
		context: CancellationContext,
		headers: Headers
	): Promise<Response> {
		const id = this.getFileIdFromRequest(req)
		if (!id) throw ERRORS.FILE_NOT_FOUND

		if (req.headers.get('upload-offset') === null) {
			throw ERRORS.MISSING_OFFSET
		}

		const offset = Number.parseInt(
			req.headers.get('upload-offset') as string,
			10
		)

		const content_type = req.headers.get('content-type')
		if (content_type === null) {
			throw ERRORS.INVALID_CONTENT_TYPE
		}

		if (this.opts.onIncomingRequest) {
			await this.opts.onIncomingRequest(req, id)
		}

		const maxFileSize = this.opts.maxSize ?? 0
		const lock = await this.acquireLock(id, context)

		let upload: Upload
		let newOffset: number
		try {
			upload = await this.store.getUpload(id)

			// Expiration check
			const now = Date.now()
			const creation = upload.creation_date
				? new Date(upload.creation_date).getTime()
				: now
			const expiration =
				creation + this.store.getExpiration()
			if (
				this.store.hasExtension('expiration') &&
				this.store.getExpiration() > 0 &&
				now > expiration
			) {
				throw ERRORS.FILE_NO_LONGER_EXISTS
			}

			if (upload.offset !== offset) {
				throw ERRORS.INVALID_OFFSET
			}

			// Deferred length declaration
			const upload_length = req.headers.get('upload-length')
			if (upload_length !== null) {
				const size = Number.parseInt(upload_length, 10)
				if (
					!this.store.hasExtension('creation-defer-length')
				) {
					throw ERRORS.UNSUPPORTED_CREATION_DEFER_LENGTH_EXTENSION
				}
				if (upload.size !== undefined) {
					throw ERRORS.INVALID_LENGTH
				}
				if (size < upload.offset) {
					throw ERRORS.INVALID_LENGTH
				}
				if (maxFileSize > 0 && size > maxFileSize) {
					throw ERRORS.ERR_MAX_SIZE_EXCEEDED
				}
				await this.store.declareUploadLength(id, size)
				upload.size = size
			}

			const maxBodySize = this.calculateMaxBodySize(
				req,
				upload,
				maxFileSize
			)
			newOffset = await this.writeToStore(
				req.body,
				upload,
				maxBodySize,
				context
			)
		} finally {
			await lock.unlock()
		}

		upload.offset = newOffset

		const responseHeaders: Record<string, string | number> =
			{
				...Object.fromEntries(headers.entries()),
				'Upload-Offset': newOffset.toString()
			}

		let status = 204
		let body = ''

		if (
			newOffset === upload.size &&
			this.opts.onUploadFinish
		) {
			const hookResponse = await this.opts.onUploadFinish(
				req,
				upload
			)
			if (hookResponse) {
				if (hookResponse.status_code)
					status = hookResponse.status_code
				if (hookResponse.body) body = hookResponse.body
				if (hookResponse.headers) {
					Object.assign(
						responseHeaders,
						hookResponse.headers
					)
				}
			}
		}

		// Expiration header for incomplete uploads
		if (
			this.store.hasExtension('expiration') &&
			this.store.getExpiration() > 0 &&
			upload.creation_date &&
			(upload.size === undefined || newOffset < upload.size)
		) {
			const creation = new Date(upload.creation_date)
			responseHeaders['Upload-Expires'] = new Date(
				creation.getTime() + this.store.getExpiration()
			).toUTCString()
		}

		return new Response(status === 204 ? null : body, {
			status,
			headers: responseHeaders as Record<string, string>
		})
	}

	private async handleDelete(
		req: Request,
		context: CancellationContext,
		headers: Headers
	): Promise<Response> {
		const id = this.getFileIdFromRequest(req)
		if (!id) throw ERRORS.FILE_NOT_FOUND

		if (this.opts.onIncomingRequest) {
			await this.opts.onIncomingRequest(req, id)
		}

		const lock = await this.acquireLock(id, context)
		try {
			await this.store.remove(id)
		} finally {
			await lock.unlock()
		}

		return new Response(null, {
			status: 204,
			headers
		})
	}

	// ── Internal Helpers ────────────────────────────────────────────────────

	private getFileIdFromRequest(
		req: Request
	): string | undefined {
		const url = new URL(req.url)
		// Strip the path prefix and get the last segment
		const pathAfterPrefix = url.pathname
			.replace(this.opts.path, '')
			.replace(/^\//, '')
		if (!pathAfterPrefix) return undefined
		const match = reExtractFileID.exec(pathAfterPrefix)
		return match ? decodeURIComponent(match[1]) : undefined
	}

	private generateUrl(req: Request, id: string): string {
		const path =
			this.opts.path === '/' ? '' : this.opts.path

		if (this.opts.relativeLocation) {
			return `${path}/${id}`
		}

		const { proto, host } = extractHostAndProto(
			req.headers,
			this.opts.respectForwardedHeaders
		)
		return `${proto}://${host}${path}/${id}`
	}

	private async acquireLock(
		id: string,
		context: CancellationContext
	) {
		const locker = this.opts.locker
		const lock = locker.newLock(id)
		await lock.lock(context.signal, () => {
			context.cancel()
		})
		return lock
	}

	private writeToStore(
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

			nodeStream.on('error', () => {
				/* swallow client disconnections */
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
						return this.store.write(
							s as StreamLimiter,
							upload.id,
							upload.offset
						)
					}
				)
				.then(resolve)
				.catch(reject)
				.finally(() => {
					context.signal.removeEventListener(
						'abort',
						onAbort
					)
				})
		})
	}

	private calculateMaxBodySize(
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

	private writeResponse(
		context: CancellationContext,
		headers: Headers,
		status: number,
		body = ''
	): Response {
		if (status !== 204 && body) {
			headers.set(
				'Content-Length',
				String(Buffer.byteLength(body, 'utf8'))
			)
		}
		if (context.signal.aborted) {
			headers.set('Connection', 'close')
		}
		return new Response(body, { status, headers })
	}

	private createContext(): CancellationContext {
		const requestAbortController = new AbortController()
		const abortWithDelayController = new AbortController()

		abortWithDelayController.signal.addEventListener(
			'abort',
			() => {
				setTimeout(() => {
					if (!requestAbortController.signal.aborted) {
						requestAbortController.abort(ERRORS.ABORTED)
					}
				}, this.opts.lockDrainTimeout)
			},
			{ once: true }
		)

		return {
			signal: requestAbortController.signal,
			abort: () => {
				if (!requestAbortController.signal.aborted) {
					requestAbortController.abort(ERRORS.ABORTED)
				}
			},
			cancel: () => {
				if (!abortWithDelayController.signal.aborted) {
					abortWithDelayController.abort(ERRORS.ABORTED)
				}
			}
		}
	}
}
