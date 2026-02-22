/**
 * Hindsight procedure handlers — banks, retain, recall, reflect, memories, entities, stats.
 *
 * Uses the @ellie/rpc procedure handler system for typed routing.
 */

import { handleProcedureRequest } from "@ellie/rpc/server"
import type { PartialProcedureHandlers } from "@ellie/rpc/server"
import { appRouter, type AppRouter } from "@ellie/router"
import type { Hindsight } from "../hindsight"
import type {
	RetainOptions,
	RetainBatchOptions,
	RecallOptions,
	ReflectOptions,
	ListMemoryUnitsOptions,
	BankConfig,
	DispositionTraits,
} from "../types"

/** Loosely-typed input record from the RPC layer. */
type RpcInput = Record<string, unknown> | undefined | null

/**
 * Create procedure handlers for all hindsight procedures.
 * Each handler receives (input, params) and returns the result.
 */
export function createHindsightHandlers(
	hs: Hindsight,
): PartialProcedureHandlers<AppRouter> {
	return {
		// ── Bank CRUD ──

		createBank: async (raw: unknown) => {
			const input = raw as RpcInput
			if (!input?.name || typeof input.name !== "string") {
				throw new Error("Missing 'name' field")
			}
			return hs.createBank(input.name, {
				description: input.description as string | undefined,
				config: input.config as BankConfig | undefined,
				disposition: input.disposition as
					| Partial<DispositionTraits>
					| undefined,
				mission: input.mission as string | undefined,
			})
		},

		listBanks: async () => {
			return hs.listBanks()
		},

		getBank: async (_input: unknown, params) => {
			const bank = hs.getBankById(params.bankId)
			if (!bank) throw new Error("Bank not found")
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

		// ── Core operations ──

		retain: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.content || typeof input.content !== "string") {
				throw new Error("Missing 'content' field")
			}
			return hs.retain(
				params.bankId,
				input.content,
				input.options as RetainOptions | undefined,
			)
		},

		retainBatch: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!Array.isArray(input?.contents) || input.contents.length === 0) {
				throw new Error("Missing or empty 'contents' array")
			}
			return hs.retainBatch(
				params.bankId,
				input.contents as string[],
				input.options as RetainBatchOptions | undefined,
			)
		},

		recall: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.query || typeof input.query !== "string") {
				throw new Error("Missing 'query' field")
			}
			return hs.recall(
				params.bankId,
				input.query,
				input.options as RecallOptions | undefined,
			)
		},

		reflect: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.query || typeof input.query !== "string") {
				throw new Error("Missing 'query' field")
			}
			return hs.reflect(
				params.bankId,
				input.query,
				input.options as ReflectOptions | undefined,
			)
		},

		// ── Stats, memories, entities ──

		getBankStats: async (_input: unknown, params) => {
			return hs.getBankStats(params.bankId)
		},

		listMemoryUnits: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: ListMemoryUnitsOptions = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			if (input?.factType)
				options.factType =
					input.factType as ListMemoryUnitsOptions["factType"]
			if (input?.searchQuery) options.searchQuery = input.searchQuery as string
			return hs.listMemoryUnits(params.bankId, options)
		},

		getMemoryUnit: async (_input: unknown, params) => {
			const detail = hs.getMemoryUnit(params.bankId, params.memoryId)
			if (!detail) throw new Error("Memory unit not found")
			return detail
		},

		deleteMemoryUnit: async (_input: unknown, params) => {
			return hs.deleteMemoryUnit(params.memoryId)
		},

		listEntities: async (raw: unknown, params) => {
			const input = raw as RpcInput
			const options: { limit?: number; offset?: number } = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			return hs.listEntities(params.bankId, options)
		},

		getEntity: async (_input: unknown, params) => {
			const detail = hs.getEntity(params.bankId, params.entityId)
			if (!detail) throw new Error("Entity not found")
			return detail
		},

		// ── Episodes ──

		listEpisodes: async (raw: unknown, params) => {
			const input = raw as RpcInput
			return hs.listEpisodes(params.bankId, {
				profile: input?.profile as string | undefined,
				project: input?.project as string | undefined,
				session: input?.session as string | undefined,
				limit: input?.limit ? Number(input.limit) : undefined,
				cursor: input?.cursor as string | undefined,
			})
		},

		narrative: async (raw: unknown, params) => {
			const input = raw as RpcInput
			if (!input?.anchorMemoryId || typeof input.anchorMemoryId !== "string") {
				throw new Error("Missing 'anchorMemoryId' field")
			}
			return hs.narrative(params.bankId, {
				anchorMemoryId: input.anchorMemoryId,
				direction: input.direction as "before" | "after" | "both" | undefined,
				steps: input.steps ? Number(input.steps) : undefined,
			})
		},
	}
}

/**
 * Handle Hindsight-specific HTTP routes via the RPC procedure handler.
 * Returns a Response Promise if matched, or null.
 */
export function handleHindsightRequest(
	hs: Hindsight,
	req: Request,
	pathname: string,
): Promise<Response> | null {
	const handlers = createHindsightHandlers(hs)
	return handleProcedureRequest(appRouter._def, req, pathname, handlers)
}
