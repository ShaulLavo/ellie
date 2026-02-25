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

/**
 * Create procedure handlers for all hindsight procedures.
 * Each handler receives (input, params) and returns the result.
 */
export function createHindsightHandlers(hs: Hindsight): ProcedureHandlers {
	return {
		createBank: async (raw: unknown) => {
			const input = raw as RpcInput
			if (!input?.name || typeof input.name !== 'string') {
				throw new Error("Missing 'name' field")
			}
			return hs.createBank(input.name, {
				description: input.description as string | undefined,
				config: input.config as BankConfig | undefined,
				disposition: input.disposition as Partial<DispositionTraits> | undefined,
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
			if (!input?.content || typeof input.content !== 'string') {
				throw new Error("Missing 'content' field")
			}
			return hs.retain(params.bankId, input.content, input.options as RetainOptions | undefined)
		},

		retainBatch: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!Array.isArray(input?.contents) || input.contents.length === 0) {
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
			if (!input?.query || typeof input.query !== 'string') {
				throw new Error("Missing 'query' field")
			}
			return hs.recall(params.bankId, input.query, input.options as RecallOptions | undefined)
		},

		reflect: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.query || typeof input.query !== 'string') {
				throw new Error("Missing 'query' field")
			}
			return hs.reflect(params.bankId, input.query, input.options as ReflectOptions | undefined)
		},

		getBankStats: async (_input: unknown, params) => hs.getBankStats(params.bankId),

		listMemoryUnits: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: ListMemoryUnitsOptions = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			if (input?.factType) {
				options.factType = input.factType as ListMemoryUnitsOptions['factType']
			}
			if (input?.searchQuery) options.searchQuery = input.searchQuery as string
			return hs.listMemoryUnits(params.bankId, options)
		},

		getMemoryUnit: async (_input: unknown, params) => {
			const detail = hs.getMemoryUnit(params.bankId, params.memoryId)
			if (!detail) throw new Error('Memory unit not found')
			return detail
		},

		deleteMemoryUnit: async (_input: unknown, params) => hs.deleteMemoryUnit(params.memoryId),

		listEntities: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: { limit?: number; offset?: number } = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			return hs.listEntities(params.bankId, options)
		},

		getEntity: async (_input: unknown, params) => {
			const detail = hs.getEntity(params.bankId, params.entityId)
			if (!detail) throw new Error('Entity not found')
			return detail
		},

		listEpisodes: async (raw: unknown, params) => {
			const input = raw as RpcInput
			return hs.listEpisodes(params.bankId, {
				profile: input?.profile as string | undefined,
				project: input?.project as string | undefined,
				session: input?.session as string | undefined,
				limit: input?.limit ? Number(input.limit) : undefined,
				cursor: input?.cursor as string | undefined
			})
		},

		narrative: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.anchorMemoryId || typeof input.anchorMemoryId !== 'string') {
				throw new Error("Missing 'anchorMemoryId' field")
			}

			const validDirections = ['before', 'after', 'both'] as const
			const direction =
				input.direction != null ? validDirections.find(d => d === input.direction) : undefined
			if (input.direction != null && direction === undefined) {
				throw new Error(`Invalid 'direction': must be one of ${validDirections.join(', ')}`)
			}

			return hs.narrative(params.bankId, {
				anchorMemoryId: input.anchorMemoryId,
				direction,
				steps: input.steps ? Number(input.steps) : undefined
			})
		},

		// Phase 3: Location APIs
		locationRecord: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.path || typeof input.path !== 'string') {
				throw new Error("Missing 'path' field")
			}
			const context = input.context as Record<string, unknown> | undefined
			if (!context?.memoryId || typeof context.memoryId !== 'string') {
				throw new Error("Missing 'context.memoryId' field")
			}
			const scope = input.scope as { profile?: string; project?: string } | undefined
			await hs.locationRecord(
				params.bankId,
				input.path,
				{
					memoryId: context.memoryId,
					session: typeof context.session === 'string' ? context.session : undefined,
					activityType:
						typeof context.activityType === 'string' &&
						['access', 'retain', 'recall'].includes(context.activityType)
							? (context.activityType as 'access' | 'retain' | 'recall')
							: undefined
				},
				scope
			)
			return { ok: true }
		},

		locationFind: async (raw: unknown, params) => {
			const input = raw as RpcInput
			return hs.locationFind(params.bankId, {
				query: typeof input?.query === 'string' ? input.query : undefined,
				path: typeof input?.path === 'string' ? input.path : undefined,
				limit: input?.limit ? Number(input.limit) : undefined,
				scope: input?.scope as { profile?: string; project?: string } | undefined
			})
		},

		locationStats: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.path || typeof input.path !== 'string') {
				throw new Error("Missing 'path' field")
			}
			const scope = input.scope as { profile?: string; project?: string } | undefined
			const stats = await hs.locationStats(params.bankId, input.path, scope)
			if (!stats) throw new Error('Path not found')
			return stats
		}
	}
}

function errorStatus(error: unknown): number {
	if (error instanceof SyntaxError) return 400
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
	if (message.includes(`not found`)) return 404
	if (message.includes(`missing`) || message.includes(`empty`) || message.includes(`invalid`)) {
		return 400
	}
	return 500
}

function createHindsightApp(hs: Hindsight) {
	const handlers = createHindsightHandlers(hs)

	const invoke = (
		name: string,
		input: unknown,
		params: Record<string, string>
	): Promise<unknown> | unknown => {
		const handler = handlers[name]
		if (!handler) throw new Error(`Handler '${name}' not found`)
		return handler(input, params)
	}

	return (
		new Elysia()
			.onError(({ code, error, set }) => {
				if (code === 'VALIDATION') {
					set.status = 400
					return { error: error.message }
				}

				const message = error instanceof Error ? error.message : String(error)
				set.status = errorStatus(error)
				return { error: message }
			})
			.post('/banks', ({ body }) => invoke('createBank', body, {}), {
				body: createBankInputSchema
			})
			.get('/banks', () => invoke('listBanks', undefined, {}))
			.get('/banks/:bankId', ({ params }) => invoke('getBank', undefined, params), {
				params: bankParamsSchema
			})
			.patch('/banks/:bankId', ({ body, params }) => invoke('updateBank', body, params), {
				params: bankParamsSchema,
				body: updateBankInputSchema
			})
			.delete('/banks/:bankId', ({ params }) => invoke('deleteBank', undefined, params), {
				params: bankParamsSchema
			})
			.post('/banks/:bankId/retain', ({ body, params }) => invoke('retain', body, params), {
				params: bankParamsSchema,
				body: retainInputSchema
			})
			.post(
				'/banks/:bankId/retain-batch',
				({ body, params }) => invoke('retainBatch', body, params),
				{
					params: bankParamsSchema,
					body: retainBatchInputSchema
				}
			)
			.post('/banks/:bankId/recall', ({ body, params }) => invoke('recall', body, params), {
				params: bankParamsSchema,
				body: recallInputSchema
			})
			.post('/banks/:bankId/reflect', ({ body, params }) => invoke('reflect', body, params), {
				params: bankParamsSchema,
				body: reflectInputSchema
			})
			.get('/banks/:bankId/stats', ({ params }) => invoke('getBankStats', undefined, params), {
				params: bankParamsSchema
			})
			.get(
				'/banks/:bankId/memories',
				({ params, query }) => invoke('listMemoryUnits', query, params),
				{
					params: bankParamsSchema,
					query: listMemoryUnitsQuerySchema
				}
			)
			.get(
				'/banks/:bankId/memories/:memoryId',
				({ params }) => invoke('getMemoryUnit', undefined, params),
				{
					params: memoryParamsSchema
				}
			)
			.delete(
				'/banks/:bankId/memories/:memoryId',
				({ params }) => invoke('deleteMemoryUnit', undefined, params),
				{
					params: memoryParamsSchema
				}
			)
			.get(
				'/banks/:bankId/entities',
				({ params, query }) => invoke('listEntities', query, params),
				{
					params: bankParamsSchema,
					query: listEntitiesQuerySchema
				}
			)
			.get(
				'/banks/:bankId/entities/:entityId',
				({ params }) => invoke('getEntity', undefined, params),
				{
					params: entityParamsSchema
				}
			)
			.get(
				'/banks/:bankId/episodes',
				({ params, query }) => invoke('listEpisodes', query, params),
				{
					params: bankParamsSchema,
					query: listEpisodesQuerySchema
				}
			)
			.post('/banks/:bankId/narrative', ({ body, params }) => invoke('narrative', body, params), {
				params: bankParamsSchema,
				body: narrativeInputSchema
			})
			// Phase 3: Location APIs
			.post(
				'/banks/:bankId/location/record',
				({ body, params }) => invoke('locationRecord', body, params),
				{ params: bankParamsSchema }
			)
			.post(
				'/banks/:bankId/location/find',
				({ body, params }) => invoke('locationFind', body, params),
				{ params: bankParamsSchema }
			)
			.post(
				'/banks/:bankId/location/stats',
				({ body, params }) => invoke('locationStats', body, params),
				{ params: bankParamsSchema }
			)
	)
}

function isHindsightPath(pathname: string): boolean {
	return pathname === '/banks' || pathname.startsWith('/banks/')
}

const appCache = new WeakMap<Hindsight, ReturnType<typeof createHindsightApp>>()

/**
 * Handle Hindsight HTTP routes.
 * Returns null when the request does not target `/banks*`.
 */
export function handleHindsightRequest(
	hs: Hindsight,
	req: Request,
	pathname: string
): Promise<Response> | null {
	if (!isHindsightPath(pathname)) return null

	let app = appCache.get(hs)
	if (!app) {
		app = createHindsightApp(hs)
		appCache.set(hs, app)
	}

	return app.handle(req)
}
