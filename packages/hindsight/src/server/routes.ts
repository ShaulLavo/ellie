/**
 * Hindsight procedure handlers — banks, retain, recall, reflect, memories, entities, stats.
 *
 * Uses the @ellie/rpc procedure handler system for typed routing.
 */

import { handleProcedureRequest } from "@ellie/rpc/server"
import type { ProcedureHandlers } from "@ellie/rpc/server"
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

/**
 * Create procedure handlers for all hindsight procedures.
 * Each handler receives (input, params) and returns the result.
 */
export function createHindsightHandlers(
	hs: Hindsight,
): ProcedureHandlers<AppRouter> {
	return {
		// ── Bank CRUD ──

		createBank: async (input: any) => {
			if (!input?.name || typeof input.name !== "string") {
				throw new Error("Missing 'name' field")
			}
			return hs.createBank(input.name, {
				description: input.description,
				config: input.config as BankConfig | undefined,
				disposition: input.disposition as
					| Partial<DispositionTraits>
					| undefined,
				mission: input.mission,
			})
		},

		listBanks: async () => {
			return hs.listBanks()
		},

		getBank: async (_input: any, params) => {
			const bank = hs.getBankById(params.bankId)
			if (!bank) throw new Error("Bank not found")
			return bank
		},

		updateBank: async (input: any, params) => {
			return hs.updateBank(params.bankId, input ?? {})
		},

		deleteBank: async (_input: any, params) => {
			hs.deleteBank(params.bankId)
			return undefined
		},

		// ── Core operations ──

		retain: async (input: any, params) => {
			if (!input?.content || typeof input.content !== "string") {
				throw new Error("Missing 'content' field")
			}
			return hs.retain(
				params.bankId,
				input.content,
				input.options as RetainOptions | undefined,
			)
		},

		retainBatch: async (input: any, params) => {
			if (!Array.isArray(input?.contents) || input.contents.length === 0) {
				throw new Error("Missing or empty 'contents' array")
			}
			return hs.retainBatch(
				params.bankId,
				input.contents,
				input.options as RetainBatchOptions | undefined,
			)
		},

		recall: async (input: any, params) => {
			if (!input?.query || typeof input.query !== "string") {
				throw new Error("Missing 'query' field")
			}
			return hs.recall(
				params.bankId,
				input.query,
				input.options as RecallOptions | undefined,
			)
		},

		reflect: async (input: any, params) => {
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

		getBankStats: async (_input: any, params) => {
			return hs.getBankStats(params.bankId)
		},

		listMemoryUnits: async (input: any, params) => {
			const options: ListMemoryUnitsOptions = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			if (input?.factType)
				options.factType =
					input.factType as ListMemoryUnitsOptions["factType"]
			if (input?.searchQuery) options.searchQuery = input.searchQuery
			return hs.listMemoryUnits(params.bankId, options)
		},

		getMemoryUnit: async (_input: any, params) => {
			const detail = hs.getMemoryUnit(params.bankId, params.memoryId)
			if (!detail) throw new Error("Memory unit not found")
			return detail
		},

		deleteMemoryUnit: async (_input: any, params) => {
			return hs.deleteMemoryUnit(params.memoryId)
		},

		listEntities: async (input: any, params) => {
			const options: { limit?: number; offset?: number } = {}
			if (input?.limit) options.limit = Number(input.limit)
			if (input?.offset) options.offset = Number(input.offset)
			return hs.listEntities(params.bankId, options)
		},

		getEntity: async (_input: any, params) => {
			const detail = hs.getEntity(params.bankId, params.entityId)
			if (!detail) throw new Error("Entity not found")
			return detail
		},
	}
}

/**
 * Handle Hindsight-specific HTTP routes via the RPC procedure handler.
 * Returns a Response Promise if matched, or null.
 *
 * This is the convenience wrapper — drop-in replacement for the old regex dispatcher.
 */
export function handleHindsightRequest(
	hs: Hindsight,
	req: Request,
	pathname: string,
): Promise<Response> | null {
	const handlers = createHindsightHandlers(hs)
	return handleProcedureRequest(appRouter._def, req, pathname, handlers)
}
