/**
 * Hindsight HTTP routes — native Elysia endpoints with Valibot schemas.
 */

import { Elysia } from 'elysia'
import * as v from 'valibot'
import {
	createBankInputSchema,
	factTypeSchema,
	narrativeInputSchema,
	recallInputSchema,
	reflectInputSchema,
	retainBatchInputSchema,
	retainInputSchema,
	updateBankInputSchema
} from '@ellie/schemas/hindsight'
import { tryValibotSummary } from '@ellie/schemas'
import type { Hindsight } from '../hindsight'
import type {
	BankConfig,
	DispositionTraits,
	ListMemoryUnitsOptions,
	RecallOptions,
	ReflectOptions,
	RetainBatchOptions,
	RetainOptions
} from '../types'

type RpcInput = Record<string, unknown> | undefined | null
type ProcedureHandler = (
	input: unknown,
	params: Record<string, string>
) => Promise<unknown> | unknown
type ProcedureHandlers = Record<string, ProcedureHandler>
type InvokeFn = (
	name: string,
	input: unknown,
	params: Record<string, string>,
	request?: Request
) => Promise<unknown> | unknown

// ── Trace propagation types ─────────────────────────────────────────────────
// Structural match for @ellie/trace types — no import needed.

/** Trace scope for propagation via HTTP headers. */
export interface HindsightRouteTraceScope {
	traceId: string
	spanId: string
	parentSpanId?: string
	sessionId?: string
}

/** Callback to record a trace event. Injected by the server. */
export type HindsightRouteTraceRecordFn = (
	scope: HindsightRouteTraceScope,
	kind: string,
	component: string,
	payload: unknown
) => void

/** Scope factory functions, injected by the server. */
export interface HindsightRouteTraceFactory {
	createRootScope: (opts?: {
		sessionId?: string
	}) => HindsightRouteTraceScope
	createChildScope: (
		parent: HindsightRouteTraceScope
	) => HindsightRouteTraceScope
}

/** Optional trace context for Hindsight routes. */
export interface HindsightRouteTraceContext {
	record: HindsightRouteTraceRecordFn
	factory: HindsightRouteTraceFactory
}

const TRACED_OPERATIONS = new Set([
	'retain',
	'retainBatch',
	'recall',
	'reflect',
	'narrative'
])

function extractTraceScope(
	trace: HindsightRouteTraceContext,
	request?: Request
): HindsightRouteTraceScope {
	const traceId = request?.headers.get('x-trace-id')
	const parentSpanId = request?.headers.get(
		'x-parent-span-id'
	)
	const sessionId = request?.headers.get('x-session-id')

	if (traceId && parentSpanId) {
		return {
			traceId,
			spanId: parentSpanId,
			sessionId: sessionId ?? undefined
		}
	}
	return trace.factory.createRootScope({
		sessionId: sessionId ?? undefined
	})
}

const bankParamsSchema = v.object({ bankId: v.string() })
const memoryParamsSchema = v.object({
	bankId: v.string(),
	memoryId: v.string()
})
const entityParamsSchema = v.object({
	bankId: v.string(),
	entityId: v.string()
})

const listMemoryUnitsQuerySchema = v.object({
	limit: v.optional(v.string()),
	offset: v.optional(v.string()),
	factType: v.optional(factTypeSchema),
	searchQuery: v.optional(v.string())
})

const listEntitiesQuerySchema = v.object({
	limit: v.optional(v.string()),
	offset: v.optional(v.string())
})

const listEpisodesQuerySchema = v.object({
	profile: v.optional(v.string()),
	project: v.optional(v.string()),
	session: v.optional(v.string()),
	limit: v.optional(v.string()),
	cursor: v.optional(v.string())
})

// ── Handler groups ──────────────────────────────────────────────────────────

function createBankHandlers(
	hs: Hindsight
): ProcedureHandlers {
	return {
		createBank: async (raw: unknown) => {
			const input = raw as RpcInput
			if (!input?.name || typeof input.name !== 'string') {
				throw new Error("Missing 'name' field")
			}
			return hs.createBank(input.name, {
				description: input.description as
					| string
					| undefined,
				config: input.config as BankConfig | undefined,
				disposition: input.disposition as
					| Partial<DispositionTraits>
					| undefined,
				mission: input.mission as string | undefined
			})
		},

		listBanks: async () => hs.listBanks(),

		getBank: async (_input: unknown, params) => {
			const bank = hs.getBankById(params.bankId)
			if (!bank) throw new Error('Bank not found')
			return bank
		},

		updateBank: async (raw: unknown, params) => {
			const input = (raw ?? {}) as Record<string, unknown>
			return hs.updateBank(params.bankId, input)
		},

		deleteBank: async (_input: unknown, params) => {
			hs.deleteBank(params.bankId)
			return undefined
		},

		retain: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.content ||
				typeof input.content !== 'string'
			) {
				throw new Error("Missing 'content' field")
			}
			return hs.retain(
				params.bankId,
				input.content,
				input.options as RetainOptions | undefined
			)
		},

		retainBatch: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!Array.isArray(input?.contents) ||
				input.contents.length === 0
			) {
				throw new Error("Missing or empty 'contents' array")
			}
			return hs.retainBatch(
				params.bankId,
				input.contents as string[],
				input.options as RetainBatchOptions | undefined
			)
		},

		recall: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.query ||
				typeof input.query !== 'string'
			) {
				throw new Error("Missing 'query' field")
			}
			return hs.recall(
				params.bankId,
				input.query,
				input.options as RecallOptions | undefined
			)
		},

		reflect: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.query ||
				typeof input.query !== 'string'
			) {
				throw new Error("Missing 'query' field")
			}
			return hs.reflect(
				params.bankId,
				input.query,
				input.options as ReflectOptions | undefined
			)
		},

		getBankStats: async (_input: unknown, params) =>
			hs.getBankStats(params.bankId),

		listMemoryUnits: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: ListMemoryUnitsOptions = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset)
				options.offset = Number(input.offset)
			if (input?.factType) {
				options.factType =
					input.factType as ListMemoryUnitsOptions['factType']
			}
			if (input?.searchQuery)
				options.searchQuery = input.searchQuery as string
			return hs.listMemoryUnits(params.bankId, options)
		},

		getMemoryUnit: async (_input: unknown, params) => {
			const detail = hs.getMemoryUnit(
				params.bankId,
				params.memoryId
			)
			if (!detail) throw new Error('Memory unit not found')
			return detail
		},

		deleteMemoryUnit: async (_input: unknown, params) =>
			hs.deleteMemoryUnit(params.memoryId)
	}
}

function createEntityAndEpisodeHandlers(
	hs: Hindsight
): ProcedureHandlers {
	return {
		listEntities: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: { limit?: number; offset?: number } =
				{}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset)
				options.offset = Number(input.offset)
			return hs.listEntities(params.bankId, options)
		},

		getEntity: async (_input: unknown, params) => {
			const detail = hs.getEntity(
				params.bankId,
				params.entityId
			)
			if (!detail) throw new Error('Entity not found')
			return detail
		},

		listEpisodes: async (raw: unknown, params) => {
			const input = raw as RpcInput
			return hs.listEpisodes(params.bankId, {
				profile: input?.profile as string | undefined,
				project: input?.project as string | undefined,
				session: input?.session as string | undefined,
				limit: input?.limit
					? Number(input.limit)
					: undefined,
				cursor: input?.cursor as string | undefined
			})
		},

		narrative: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.anchorMemoryId ||
				typeof input.anchorMemoryId !== 'string'
			) {
				throw new Error("Missing 'anchorMemoryId' field")
			}

			const validDirections = [
				'before',
				'after',
				'both'
			] as const
			const direction =
				input.direction != null
					? validDirections.find(d => d === input.direction)
					: undefined
			if (
				input.direction != null &&
				direction === undefined
			) {
				throw new Error(
					`Invalid 'direction': must be one of ${validDirections.join(', ')}`
				)
			}

			return hs.narrative(params.bankId, {
				anchorMemoryId: input.anchorMemoryId,
				direction,
				steps: input.steps ? Number(input.steps) : undefined
			})
		}
	}
}

function createExtensionHandlers(
	hs: Hindsight
): ProcedureHandlers {
	return {
		locationRecord: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.path || typeof input.path !== 'string') {
				throw new Error("Missing 'path' field")
			}
			const context = input.context as
				| Record<string, unknown>
				| undefined
			if (
				!context?.memoryId ||
				typeof context.memoryId !== 'string'
			) {
				throw new Error("Missing 'context.memoryId' field")
			}
			const scope = input.scope as
				| { profile?: string; project?: string }
				| undefined
			await hs.locationRecord(
				params.bankId,
				input.path,
				{
					memoryId: context.memoryId,
					session:
						typeof context.session === 'string'
							? context.session
							: undefined,
					activityType:
						typeof context.activityType === 'string' &&
						['access', 'retain', 'recall'].includes(
							context.activityType
						)
							? (context.activityType as
									| 'access'
									| 'retain'
									| 'recall')
							: undefined
				},
				scope
			)
			return { ok: true }
		},

		locationFind: async (raw: unknown, params) => {
			const input = raw as RpcInput
			return hs.locationFind(params.bankId, {
				query:
					typeof input?.query === 'string'
						? input.query
						: undefined,
				path:
					typeof input?.path === 'string'
						? input.path
						: undefined,
				limit: input?.limit
					? Number(input.limit)
					: undefined,
				scope: input?.scope as
					| { profile?: string; project?: string }
					| undefined
			})
		},

		locationStats: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.path || typeof input.path !== 'string') {
				throw new Error("Missing 'path' field")
			}
			const scope = input.scope as
				| { profile?: string; project?: string }
				| undefined
			const stats = await hs.locationStats(
				params.bankId,
				input.path,
				scope
			)
			if (!stats) throw new Error('Path not found')
			return stats
		},

		retainVisual: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.description ||
				typeof input.description !== 'string'
			) {
				throw new Error("Missing 'description' field")
			}
			return hs.retainVisual({
				bankId: params.bankId,
				sourceId:
					typeof input.sourceId === 'string'
						? input.sourceId
						: undefined,
				description: input.description,
				ts:
					typeof input.ts === 'number'
						? input.ts
						: undefined,
				scope: input.scope as
					| {
							profile?: string
							project?: string
							session?: string
					  }
					| undefined
			})
		},

		visualStats: async (_input: unknown, params) =>
			hs.visualStats(params.bankId),

		visualFind: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (
				!input?.query ||
				typeof input.query !== 'string'
			) {
				throw new Error("Missing 'query' field")
			}
			return hs.visualFind(
				params.bankId,
				input.query,
				input.limit ? Number(input.limit) : undefined
			)
		}
	}
}

/**
 * Create procedure handlers for all hindsight procedures.
 * Each handler receives (input, params) and returns the result.
 */
export function createHindsightHandlers(
	hs: Hindsight
): ProcedureHandlers {
	return {
		...createBankHandlers(hs),
		...createEntityAndEpisodeHandlers(hs),
		...createExtensionHandlers(hs)
	}
}

// ── Route groups ────────────────────────────────────────────────────────────

function bankAndMemoryRoutes(invoke: InvokeFn) {
	return new Elysia()
		.post(
			'/banks',
			({ body }) => invoke('createBank', body, {}),
			{ body: createBankInputSchema }
		)
		.get('/banks', () => invoke('listBanks', undefined, {}))
		.get(
			'/banks/:bankId',
			({ params }) => invoke('getBank', undefined, params),
			{ params: bankParamsSchema }
		)
		.patch(
			'/banks/:bankId',
			({ body, params }) =>
				invoke('updateBank', body, params),
			{
				params: bankParamsSchema,
				body: updateBankInputSchema
			}
		)
		.delete(
			'/banks/:bankId',
			({ params }) =>
				invoke('deleteBank', undefined, params),
			{ params: bankParamsSchema }
		)
		.post(
			'/banks/:bankId/retain',
			({ body, params, request }) =>
				invoke('retain', body, params, request),
			{
				params: bankParamsSchema,
				body: retainInputSchema
			}
		)
		.post(
			'/banks/:bankId/retain-batch',
			({ body, params, request }) =>
				invoke('retainBatch', body, params, request),
			{
				params: bankParamsSchema,
				body: retainBatchInputSchema
			}
		)
		.post(
			'/banks/:bankId/recall',
			({ body, params, request }) =>
				invoke('recall', body, params, request),
			{
				params: bankParamsSchema,
				body: recallInputSchema
			}
		)
		.post(
			'/banks/:bankId/reflect',
			({ body, params, request }) =>
				invoke('reflect', body, params, request),
			{
				params: bankParamsSchema,
				body: reflectInputSchema
			}
		)
		.get(
			'/banks/:bankId/stats',
			({ params }) =>
				invoke('getBankStats', undefined, params),
			{ params: bankParamsSchema }
		)
		.get(
			'/banks/:bankId/memories',
			({ params, query }) =>
				invoke('listMemoryUnits', query, params),
			{
				params: bankParamsSchema,
				query: listMemoryUnitsQuerySchema
			}
		)
		.get(
			'/banks/:bankId/memories/:memoryId',
			({ params }) =>
				invoke('getMemoryUnit', undefined, params),
			{ params: memoryParamsSchema }
		)
		.delete(
			'/banks/:bankId/memories/:memoryId',
			({ params }) =>
				invoke('deleteMemoryUnit', undefined, params),
			{ params: memoryParamsSchema }
		)
}

function entityAndEpisodeRoutes(invoke: InvokeFn) {
	return new Elysia()
		.get(
			'/banks/:bankId/entities',
			({ params, query }) =>
				invoke('listEntities', query, params),
			{
				params: bankParamsSchema,
				query: listEntitiesQuerySchema
			}
		)
		.get(
			'/banks/:bankId/entities/:entityId',
			({ params }) =>
				invoke('getEntity', undefined, params),
			{ params: entityParamsSchema }
		)
		.get(
			'/banks/:bankId/episodes',
			({ params, query }) =>
				invoke('listEpisodes', query, params),
			{
				params: bankParamsSchema,
				query: listEpisodesQuerySchema
			}
		)
		.post(
			'/banks/:bankId/narrative',
			({ body, params, request }) =>
				invoke('narrative', body, params, request),
			{
				params: bankParamsSchema,
				body: narrativeInputSchema
			}
		)
}

function extensionRoutes(invoke: InvokeFn) {
	return new Elysia()
		.post(
			'/banks/:bankId/location/record',
			({ body, params }) =>
				invoke('locationRecord', body, params),
			{ params: bankParamsSchema }
		)
		.post(
			'/banks/:bankId/location/find',
			({ body, params }) =>
				invoke('locationFind', body, params),
			{ params: bankParamsSchema }
		)
		.post(
			'/banks/:bankId/location/stats',
			({ body, params }) =>
				invoke('locationStats', body, params),
			{ params: bankParamsSchema }
		)
		.post(
			'/banks/:bankId/visual/retain',
			({ body, params }) =>
				invoke('retainVisual', body, params),
			{ params: bankParamsSchema }
		)
		.get(
			'/banks/:bankId/visual/stats',
			({ params }) =>
				invoke('visualStats', undefined, params),
			{ params: bankParamsSchema }
		)
		.post(
			'/banks/:bankId/visual/find',
			({ body, params }) =>
				invoke('visualFind', body, params),
			{ params: bankParamsSchema }
		)
}

// ── Error handling ──────────────────────────────────────────────────────────

function resolveValidationSummary(
	error: { validator: unknown; value: unknown },
	request: Request
): string | undefined {
	if (request.headers.get('x-error-detail') !== 'summary')
		return undefined
	return (
		tryValibotSummary(error.validator, error.value) ??
		undefined
	)
}

function errorStatus(error: unknown): number {
	if (error instanceof SyntaxError) return 400
	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase()
	if (message.includes(`not found`)) return 404
	if (
		message.includes(`missing`) ||
		message.includes(`empty`) ||
		message.includes(`invalid`)
	) {
		return 400
	}
	return 500
}

// ── App factory ─────────────────────────────────────────────────────────────

export function createHindsightApp(
	hs: Hindsight,
	trace?: HindsightRouteTraceContext
) {
	const handlers = createHindsightHandlers(hs)

	const invoke: InvokeFn = async (
		name,
		input,
		params,
		request
	) => {
		const handler = handlers[name]
		if (!handler)
			throw new Error(`Handler '${name}' not found`)

		if (!trace || !TRACED_OPERATIONS.has(name)) {
			return handler(input, params)
		}

		const parentScope = extractTraceScope(trace, request)
		const childScope =
			trace.factory.createChildScope(parentScope)
		const startedAt = Date.now()

		trace.record(
			childScope,
			`hindsight.${name}.start`,
			'hindsight',
			{ bankId: params.bankId, operation: name }
		)

		try {
			const result = await handler(input, params)
			trace.record(
				childScope,
				`hindsight.${name}.end`,
				'hindsight',
				{
					bankId: params.bankId,
					operation: name,
					elapsedMs: Date.now() - startedAt,
					success: true
				}
			)
			return result
		} catch (err) {
			trace.record(
				childScope,
				`hindsight.${name}.end`,
				'hindsight',
				{
					bankId: params.bankId,
					operation: name,
					elapsedMs: Date.now() - startedAt,
					success: false,
					error:
						err instanceof Error ? err.message : String(err)
				}
			)
			throw err
		}
	}

	return new Elysia()
		.onError(({ code, error, set, request }) => {
			if (code !== 'VALIDATION') {
				const message =
					error instanceof Error
						? error.message
						: String(error)
				set.status = errorStatus(error)
				return { error: message }
			}

			set.status = 400
			const summary = resolveValidationSummary(
				error,
				request
			)
			return { error: summary ?? error.message }
		})
		.use(bankAndMemoryRoutes(invoke))
		.use(entityAndEpisodeRoutes(invoke))
		.use(extensionRoutes(invoke))
}

function isHindsightPath(pathname: string): boolean {
	return (
		pathname === '/banks' || pathname.startsWith('/banks/')
	)
}

const untracedAppCache = new WeakMap<
	Hindsight,
	ReturnType<typeof createHindsightApp>
>()
const tracedAppCache = new WeakMap<
	Hindsight,
	ReturnType<typeof createHindsightApp>
>()

/**
 * Handle Hindsight HTTP routes.
 * Returns null when the request does not target `/banks*`.
 */
export function handleHindsightRequest(
	hs: Hindsight,
	req: Request,
	pathname: string,
	trace?: HindsightRouteTraceContext
): Promise<Response> | null {
	if (!isHindsightPath(pathname)) return null

	const cache = trace ? tracedAppCache : untracedAppCache
	let app = cache.get(hs)
	if (!app) {
		app = createHindsightApp(hs, trace)
		cache.set(hs, app)
	}

	return app.handle(req)
}
