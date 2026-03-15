/**
 * Elysia adapter for the tus protocol.
 *
 * Mounts:
 *   - Native tus routes under `prefix` (default: /api/uploads)
 *   - Minimal RPC helper routes under `${prefix}-rpc`
 *   - Localhost-only guard on all routes
 */

import { Elysia } from 'elysia'
import {
	TusServer,
	type TusServerOptions
} from '../core/server'
import type { DataStore } from '../core/data-store'
import type { Upload } from '../core/upload'

interface ConfigStoreCapable {
	configstore: {
		list: () => Promise<string[]>
		get: (key: string) => Promise<Upload | undefined>
	}
}

type ReadOptions = {
	start?: number
	end?: number
}

interface ReadableStore {
	read: (
		id: string,
		options?: ReadOptions
	) => NodeJS.ReadableStream
}

function hasConfigStore(
	s: DataStore
): s is DataStore & ConfigStoreCapable {
	const candidate = s as unknown as Record<string, unknown>
	if (
		!candidate.configstore ||
		typeof candidate.configstore !== 'object'
	) {
		return false
	}
	const cs = candidate.configstore as Record<
		string,
		unknown
	>
	return (
		typeof cs.list === 'function' &&
		typeof cs.get === 'function'
	)
}

function hasReadableStore(
	s: DataStore
): s is DataStore & ReadableStore {
	if (!('read' in s)) return false
	return typeof s.read === 'function'
}

type ByteRange = {
	start: number
	end: number
}

function parseByteRange(
	rangeHeader: string | null,
	size: number
): ByteRange | 'invalid' | null {
	if (!rangeHeader) return null
	if (size <= 0) return 'invalid'
	if (!rangeHeader.startsWith('bytes=')) return 'invalid'

	const rangeValue = rangeHeader
		.slice('bytes='.length)
		.trim()
	if (rangeValue.length === 0 || rangeValue.includes(',')) {
		return 'invalid'
	}

	const [startText, endText] = rangeValue.split('-', 2)
	if (startText === undefined || endText === undefined) {
		return 'invalid'
	}
	if (startText === '' && endText === '') return 'invalid'

	if (startText === '') {
		const suffixLength = Number.parseInt(endText, 10)
		if (
			!Number.isInteger(suffixLength) ||
			suffixLength <= 0
		) {
			return 'invalid'
		}
		const start = Math.max(size - suffixLength, 0)
		return { start, end: size - 1 }
	}

	const start = Number.parseInt(startText, 10)
	if (
		!Number.isInteger(start) ||
		start < 0 ||
		start >= size
	) {
		return 'invalid'
	}
	if (endText === '') return { start, end: size - 1 }

	const end = Number.parseInt(endText, 10)
	if (!Number.isInteger(end) || end < start)
		return 'invalid'

	return { start, end: Math.min(end, size - 1) }
}

export type CreateTusAppOptions = {
	/** The DataStore instance (e.g. FileStore). */
	datastore: DataStore

	/**
	 * Route prefix for native tus endpoints.
	 * @default '/api/uploads'
	 */
	prefix?: string

	/** Maximum upload size in bytes. */
	maxSize?: number

	/** Return relative Location URLs. */
	relativeLocation?: boolean

	/** Honour X-Forwarded-* headers. */
	respectForwardedHeaders?: boolean

	/** Hooks forwarded to TusServer. */
	onUploadCreate?: TusServerOptions['onUploadCreate']
	onUploadFinish?: TusServerOptions['onUploadFinish']
	onIncomingRequest?: TusServerOptions['onIncomingRequest']
	namingFunction?: TusServerOptions['namingFunction']
}

function createTusPlugin(
	prefix: string,
	tusServer: TusServer
) {
	const handle = ({ request }: { request: Request }) =>
		tusServer.handle(request)
	const tag = (summary: string) => ({
		detail: { tags: ['Uploads'], summary }
	})

	return new Elysia()
		.options(prefix, handle, tag('tus OPTIONS (discovery)'))
		.post(prefix, handle, tag('tus POST (create upload)'))
		.head(
			`${prefix}/:id`,
			handle,
			tag('tus HEAD (upload status)')
		)
		.patch(
			`${prefix}/:id`,
			handle,
			tag('tus PATCH (resume upload)')
		)
		.delete(
			`${prefix}/:id`,
			handle,
			tag('tus DELETE (terminate upload)')
		)
}

function createRpcPlugin(
	rpcPrefix: string,
	datastore: DataStore,
	tusServer: TusServer
) {
	const tag = (summary: string) => ({
		detail: { tags: ['Uploads'], summary }
	})

	return new Elysia()
		.get(
			`${rpcPrefix}/list`,
			async () => {
				if (!hasConfigStore(datastore))
					return { uploads: [] }
				const keys = await datastore.configstore.list()
				const uploads: Upload[] = []
				for (const key of keys) {
					const info = await datastore.configstore.get(key)
					if (info) uploads.push(info)
				}
				return { uploads }
			},
			tag('List all uploads (admin/operational helper)')
		)
		.get(
			`${rpcPrefix}/:id`,
			async ({ params, set }) => {
				try {
					return await datastore.getUpload(params.id)
				} catch {
					set.status = 404
					return { error: 'Upload not found' }
				}
			},
			tag(
				'Get upload info by ID (admin/operational helper)'
			)
		)
		.get(
			`${rpcPrefix}/:id/content`,
			async ({ params, request, set }) => {
				let upload: Awaited<
					ReturnType<typeof datastore.getUpload>
				>
				try {
					upload = await datastore.getUpload(params.id)
				} catch {
					set.status = 404
					return { error: 'Upload not found' }
				}

				if (!hasReadableStore(datastore)) {
					set.status = 501
					return {
						error:
							'Datastore does not support content reads'
					}
				}

				try {
					const contentType =
						(upload.metadata as Record<string, string>)
							?.mimeType ??
						(upload.metadata as Record<string, string>)
							?.contentType ??
						'application/octet-stream'
					const totalSize =
						upload.offset || upload.size || 0
					const range = parseByteRange(
						request.headers.get('range'),
						totalSize
					)

					set.headers['content-type'] = contentType
					set.headers['accept-ranges'] = 'bytes'

					if (range === 'invalid') {
						set.status = 416
						set.headers['content-range'] =
							`bytes */${totalSize}`
						set.headers['content-length'] = '0'
						return ''
					}

					if (range) {
						const contentLength =
							range.end - range.start + 1
						set.status = 206
						set.headers['content-range'] =
							`bytes ${range.start}-${range.end}/${totalSize}`
						set.headers['content-length'] =
							String(contentLength)
						return datastore.read(params.id, range)
					}

					if (totalSize > 0) {
						set.headers['content-length'] =
							String(totalSize)
					}
					return datastore.read(params.id)
				} catch (readErr) {
					set.status = 500
					return {
						error: `Failed to read upload content: ${readErr instanceof Error ? readErr.message : String(readErr)}`
					}
				}
			},
			tag('Get upload content by ID')
		)
		.post(
			`${rpcPrefix}/cleanup-expired`,
			async ({ set }) => {
				try {
					const count =
						await tusServer.cleanUpExpiredUploads()
					return { deleted: count }
				} catch (e) {
					set.status = 500
					return {
						error:
							e instanceof Error
								? e.message
								: 'Cleanup failed'
					}
				}
			},
			tag('Clean up expired incomplete uploads')
		)
}

export function createTusApp(options: CreateTusAppOptions) {
	const prefix = options.prefix ?? '/api/uploads'
	const rpcPrefix = `${prefix}-rpc`

	const tusServer = new TusServer({
		path: prefix,
		datastore: options.datastore,
		maxSize: options.maxSize,
		relativeLocation: options.relativeLocation,
		respectForwardedHeaders:
			options.respectForwardedHeaders,
		onUploadCreate: options.onUploadCreate,
		onUploadFinish: options.onUploadFinish,
		onIncomingRequest: options.onIncomingRequest,
		namingFunction: options.namingFunction
	})

	return new Elysia()
		.use(createTusPlugin(prefix, tusServer))
		.use(
			createRpcPlugin(
				rpcPrefix,
				options.datastore,
				tusServer
			)
		)
}
