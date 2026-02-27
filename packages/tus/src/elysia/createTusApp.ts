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

// ── Localhost guard ────────────────────────────────────────────────────────

const LOOPBACK_ADDRS = new Set([
	'127.0.0.1',
	'::1',
	'::ffff:127.0.0.1'
])

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Factory ────────────────────────────────────────────────────────────────

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

	return (
		new Elysia()
			// ── Localhost guard (applies to all routes in this plugin) ────────
			.onBeforeHandle(({ request, server, set }) => {
				const ip = server?.requestIP(request)
				const addr = ip?.address
				if (!addr || !LOOPBACK_ADDRS.has(addr)) {
					set.status = 403
					return {
						error:
							'Upload routes are only available from localhost'
					}
				}
			})

			// ── Native tus routes ────────────────────────────────────────────
			.options(
				prefix,
				({ request }) => tusServer.handle(request),
				{
					detail: {
						tags: ['Uploads'],
						summary: 'tus OPTIONS (discovery)'
					}
				}
			)
			.post(
				prefix,
				({ request }) => tusServer.handle(request),
				{
					detail: {
						tags: ['Uploads'],
						summary: 'tus POST (create upload)'
					}
				}
			)
			.head(
				`${prefix}/:id`,
				({ request }) => tusServer.handle(request),
				{
					detail: {
						tags: ['Uploads'],
						summary: 'tus HEAD (upload status)'
					}
				}
			)
			.patch(
				`${prefix}/:id`,
				({ request }) => tusServer.handle(request),
				{
					detail: {
						tags: ['Uploads'],
						summary: 'tus PATCH (resume upload)'
					}
				}
			)
			.delete(
				`${prefix}/:id`,
				({ request }) => tusServer.handle(request),
				{
					detail: {
						tags: ['Uploads'],
						summary: 'tus DELETE (terminate upload)'
					}
				}
			)

			// ── RPC helper routes ────────────────────────────────────────────

			.get(
				`${rpcPrefix}/list`,
				async () => {
					const store = options.datastore
					if (!store.hasExtension('expiration')) {
						return { uploads: [] }
					}
					// KvStore-backed listing
					const fileStore = store as unknown as {
						configstore?: {
							list?: () => Promise<string[]>
							get?: (
								key: string
							) => Promise<Upload | undefined>
						}
					}
					if (!fileStore.configstore?.list) {
						return { uploads: [] }
					}
					const keys = await fileStore.configstore.list()
					const uploads: Upload[] = []
					for (const key of keys) {
						const info =
							await fileStore.configstore.get?.(key)
						if (info) uploads.push(info)
					}
					return { uploads }
				},
				{
					detail: {
						tags: ['Uploads'],
						summary:
							'List all uploads (admin/operational helper)'
					}
				}
			)

			.get(
				`${rpcPrefix}/:id`,
				async ({ params, set }) => {
					try {
						const upload =
							await options.datastore.getUpload(params.id)
						return upload
					} catch {
						set.status = 404
						return { error: 'Upload not found' }
					}
				},
				{
					detail: {
						tags: ['Uploads'],
						summary:
							'Get upload info by ID (admin/operational helper)'
					}
				}
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
				{
					detail: {
						tags: ['Uploads'],
						summary: 'Clean up expired incomplete uploads'
					}
				}
			)
	)
}
