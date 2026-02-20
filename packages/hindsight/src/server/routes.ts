/**
 * Hindsight HTTP routes — banks, retain, recall, reflect, memories, entities, stats.
 *
 * Follows the handleAgentRequest pattern from apps/app/src/routes/agent.ts:
 * regex-based path matching dispatching to handler functions.
 */

import type { Hindsight } from "../hindsight"
import type {
	RetainOptions,
	RetainBatchOptions,
	RetainBatchItem,
	RecallOptions,
	ReflectOptions,
	ListMemoryUnitsOptions,
	BankConfig,
	DispositionTraits,
} from "../types"

/**
 * Handle Hindsight-specific HTTP routes.
 * Returns a Response Promise if matched, or null.
 */
export function handleHindsightRequest(
	hs: Hindsight,
	req: Request,
	pathname: string,
): Promise<Response> | null {
	const method = req.method

	// ── Memory unit routes (must match before /banks/:bankId) ─────────

	// GET /banks/:bankId/memories/:memoryId
	const memoryDetailMatch = pathname.match(
		/^\/banks\/([^/]+)\/memories\/([^/]+)$/,
	)
	if (memoryDetailMatch && method === "GET") {
		return handleGetMemoryUnit(
			hs,
			decodeURIComponent(memoryDetailMatch[1]),
			decodeURIComponent(memoryDetailMatch[2]),
		)
	}

	// DELETE /banks/:bankId/memories/:memoryId
	if (memoryDetailMatch && method === "DELETE") {
		return handleDeleteMemoryUnit(
			hs,
			decodeURIComponent(memoryDetailMatch[2]),
		)
	}

	// GET /banks/:bankId/memories
	const memoriesMatch = pathname.match(/^\/banks\/([^/]+)\/memories$/)
	if (memoriesMatch && method === "GET") {
		return handleListMemoryUnits(
			hs,
			req,
			decodeURIComponent(memoriesMatch[1]),
		)
	}

	// ── Entity routes ────────────────────────────────────────────────

	// GET /banks/:bankId/entities/:entityId
	const entityDetailMatch = pathname.match(
		/^\/banks\/([^/]+)\/entities\/([^/]+)$/,
	)
	if (entityDetailMatch && method === "GET") {
		return handleGetEntity(
			hs,
			decodeURIComponent(entityDetailMatch[1]),
			decodeURIComponent(entityDetailMatch[2]),
		)
	}

	// GET /banks/:bankId/entities
	const entitiesMatch = pathname.match(/^\/banks\/([^/]+)\/entities$/)
	if (entitiesMatch && method === "GET") {
		return handleListEntities(
			hs,
			req,
			decodeURIComponent(entitiesMatch[1]),
		)
	}

	// ── Core operation routes ────────────────────────────────────────

	// POST /banks/:bankId/retain
	const retainMatch = pathname.match(/^\/banks\/([^/]+)\/retain$/)
	if (retainMatch && method === "POST") {
		return handleRetain(hs, req, decodeURIComponent(retainMatch[1]))
	}

	// POST /banks/:bankId/retain-batch
	const retainBatchMatch = pathname.match(/^\/banks\/([^/]+)\/retain-batch$/)
	if (retainBatchMatch && method === "POST") {
		return handleRetainBatch(
			hs,
			req,
			decodeURIComponent(retainBatchMatch[1]),
		)
	}

	// POST /banks/:bankId/recall
	const recallMatch = pathname.match(/^\/banks\/([^/]+)\/recall$/)
	if (recallMatch && method === "POST") {
		return handleRecall(hs, req, decodeURIComponent(recallMatch[1]))
	}

	// POST /banks/:bankId/reflect
	const reflectMatch = pathname.match(/^\/banks\/([^/]+)\/reflect$/)
	if (reflectMatch && method === "POST") {
		return handleReflect(hs, req, decodeURIComponent(reflectMatch[1]))
	}

	// GET /banks/:bankId/stats
	const statsMatch = pathname.match(/^\/banks\/([^/]+)\/stats$/)
	if (statsMatch && method === "GET") {
		return handleGetBankStats(hs, decodeURIComponent(statsMatch[1]))
	}

	// ── Bank CRUD routes ─────────────────────────────────────────────

	// POST /banks
	if (pathname === "/banks" && method === "POST") {
		return handleCreateBank(hs, req)
	}

	// GET /banks
	if (pathname === "/banks" && method === "GET") {
		return handleListBanks(hs)
	}

	// GET /banks/:bankId
	const bankMatch = pathname.match(/^\/banks\/([^/]+)$/)
	if (bankMatch && method === "GET") {
		return handleGetBank(hs, decodeURIComponent(bankMatch[1]))
	}

	// PATCH /banks/:bankId
	if (bankMatch && method === "PATCH") {
		return handleUpdateBank(hs, req, decodeURIComponent(bankMatch[1]))
	}

	// DELETE /banks/:bankId
	if (bankMatch && method === "DELETE") {
		return handleDeleteBank(hs, decodeURIComponent(bankMatch[1]))
	}

	return null
}

// ── Bank handlers ────────────────────────────────────────────────────────

async function handleCreateBank(
	hs: Hindsight,
	req: Request,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			name?: string
			description?: string
			config?: BankConfig
			disposition?: Partial<DispositionTraits>
			mission?: string
		}
		if (!body.name || typeof body.name !== "string") {
			return Response.json(
				{ error: "Missing 'name' field" },
				{ status: 400 },
			)
		}
		const bank = hs.createBank(body.name, {
			description: body.description,
			config: body.config,
			disposition: body.disposition,
			mission: body.mission,
		})
		return Response.json(bank, { status: 201 })
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to create bank"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleListBanks(hs: Hindsight): Promise<Response> {
	try {
		const banks = hs.listBanks()
		return Response.json(banks)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to list banks"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleGetBank(
	hs: Hindsight,
	bankId: string,
): Promise<Response> {
	try {
		const bank = hs.getBankById(bankId)
		if (!bank) {
			return Response.json({ error: "Bank not found" }, { status: 404 })
		}
		return Response.json(bank)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to get bank"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleUpdateBank(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			name?: string
			mission?: string
		}
		const bank = hs.updateBank(bankId, body)
		return Response.json(bank)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to update bank"
		if (message.includes("not found")) {
			return Response.json({ error: message }, { status: 404 })
		}
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleDeleteBank(
	hs: Hindsight,
	bankId: string,
): Promise<Response> {
	try {
		hs.deleteBank(bankId)
		return new Response(null, { status: 204 })
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to delete bank"
		return Response.json({ error: message }, { status: 500 })
	}
}

// ── Core operation handlers ──────────────────────────────────────────────

async function handleRetain(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			content?: string
			options?: RetainOptions
		}
		if (!body.content || typeof body.content !== "string") {
			return Response.json(
				{ error: "Missing 'content' field" },
				{ status: 400 },
			)
		}
		const result = await hs.retain(bankId, body.content, body.options)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to retain"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleRetainBatch(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			contents?: (string | RetainBatchItem)[]
			options?: RetainBatchOptions
		}
		if (!Array.isArray(body.contents) || body.contents.length === 0) {
			return Response.json(
				{ error: "Missing or empty 'contents' array" },
				{ status: 400 },
			)
		}
		const result = await hs.retainBatch(
			bankId,
			body.contents as string[],
			body.options,
		)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to retain batch"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleRecall(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			query?: string
			options?: RecallOptions
		}
		if (!body.query || typeof body.query !== "string") {
			return Response.json(
				{ error: "Missing 'query' field" },
				{ status: 400 },
			)
		}
		const result = await hs.recall(bankId, body.query, body.options)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to recall"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleReflect(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			query?: string
			options?: ReflectOptions
		}
		if (!body.query || typeof body.query !== "string") {
			return Response.json(
				{ error: "Missing 'query' field" },
				{ status: 400 },
			)
		}
		const result = await hs.reflect(bankId, body.query, body.options)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to reflect"
		return Response.json({ error: message }, { status: 500 })
	}
}

// ── Stats handler ────────────────────────────────────────────────────────

async function handleGetBankStats(
	hs: Hindsight,
	bankId: string,
): Promise<Response> {
	try {
		const stats = hs.getBankStats(bankId)
		return Response.json(stats)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to get bank stats"
		return Response.json({ error: message }, { status: 500 })
	}
}

// ── Memory unit handlers ─────────────────────────────────────────────────

async function handleListMemoryUnits(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const url = new URL(req.url)
		const options: ListMemoryUnitsOptions = {}
		const limit = url.searchParams.get("limit")
		if (limit) options.limit = Number(limit)
		const offset = url.searchParams.get("offset")
		if (offset) options.offset = Number(offset)
		const factType = url.searchParams.get("factType")
		if (factType)
			options.factType = factType as ListMemoryUnitsOptions["factType"]
		const searchQuery = url.searchParams.get("searchQuery")
		if (searchQuery) options.searchQuery = searchQuery

		const result = hs.listMemoryUnits(bankId, options)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to list memory units"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleGetMemoryUnit(
	hs: Hindsight,
	bankId: string,
	memoryId: string,
): Promise<Response> {
	try {
		const detail = hs.getMemoryUnit(bankId, memoryId)
		if (!detail) {
			return Response.json(
				{ error: "Memory unit not found" },
				{ status: 404 },
			)
		}
		return Response.json(detail)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to get memory unit"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleDeleteMemoryUnit(
	hs: Hindsight,
	memoryId: string,
): Promise<Response> {
	try {
		const result = hs.deleteMemoryUnit(memoryId)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error
				? err.message
				: "Failed to delete memory unit"
		return Response.json({ error: message }, { status: 500 })
	}
}

// ── Entity handlers ──────────────────────────────────────────────────────

async function handleListEntities(
	hs: Hindsight,
	req: Request,
	bankId: string,
): Promise<Response> {
	try {
		const url = new URL(req.url)
		const options: { limit?: number; offset?: number } = {}
		const limit = url.searchParams.get("limit")
		if (limit) options.limit = Number(limit)
		const offset = url.searchParams.get("offset")
		if (offset) options.offset = Number(offset)

		const result = hs.listEntities(bankId, options)
		return Response.json(result)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to list entities"
		return Response.json({ error: message }, { status: 500 })
	}
}

async function handleGetEntity(
	hs: Hindsight,
	bankId: string,
	entityId: string,
): Promise<Response> {
	try {
		const detail = hs.getEntity(bankId, entityId)
		if (!detail) {
			return Response.json(
				{ error: "Entity not found" },
				{ status: 404 },
			)
		}
		return Response.json(detail)
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to get entity"
		return Response.json({ error: message }, { status: 500 })
	}
}
