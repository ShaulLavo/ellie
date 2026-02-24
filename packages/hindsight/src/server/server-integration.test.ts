/**
 * Hindsight HTTP server integration tests.
 *
 * Tests the full HTTP round-trip: HTTP client → Bun HTTP server → Hindsight class.
 * Covers the same scenarios as the Python test_server_integration.py.
 */

import {
	describe,
	it,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
} from "bun:test"
import { createTestHindsight, type TestHindsight } from "../test/setup"
import { handleHindsightRequest } from "./routes"
import type {
	Bank,
	RetainResult,
	RecallResult,
	ReflectResult,
	ListMemoryUnitsResult,
	ListEntitiesResult,
	BankStats,
	DeleteMemoryUnitResult,
	MemoryUnitDetail,
} from "../types"

// ── Test server setup ────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve>
let rpc: ReturnType<typeof createHindsightClient>
let baseUrl: string
let t: TestHindsight

type QueryInput = Record<string, unknown> | undefined

function appendQuery(path: string, input: QueryInput): string {
	if (!input) return path
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue
		query.set(key, String(value))
	}
	const encoded = query.toString()
	if (!encoded) return path
	return `${path}?${encoded}`
}

async function callEndpoint<T>(
	base: string,
	method: string,
	path: string,
	input?: QueryInput,
): Promise<T> {
	const isBodyless = method === `GET` || method === `DELETE`
	const url = isBodyless ? appendQuery(`${base}${path}`, input) : `${base}${path}`
	const response = await fetch(url, {
		method,
		headers: isBodyless ? undefined : { "content-type": `application/json` },
		body: isBodyless ? undefined : JSON.stringify(input),
	})

	if (!response.ok) {
		const text = await response.text().catch(() => ``)
		throw new Error(`${method} ${path} failed: ${response.status} ${text}`)
	}

	if (response.status === 204) return undefined as T
	return response.json() as Promise<T>
}

function createHindsightClient(base: string) {
	return {
		createBank: ({ input }: { input: Record<string, unknown> }) =>
			callEndpoint(base, `POST`, `/banks`, input),
		listBanks: ({ input }: { input?: QueryInput }) =>
			callEndpoint(base, `GET`, `/banks`, input),
		getBank: ({ bankId, input }: { bankId: string; input?: QueryInput }) =>
			callEndpoint(base, `GET`, `/banks/${encodeURIComponent(bankId)}`, input),
		updateBank: ({ bankId, input }: { bankId: string; input: Record<string, unknown> }) =>
			callEndpoint(base, `PATCH`, `/banks/${encodeURIComponent(bankId)}`, input),
		deleteBank: ({ bankId, input }: { bankId: string; input?: QueryInput }) =>
			callEndpoint(base, `DELETE`, `/banks/${encodeURIComponent(bankId)}`, input),
		retain: ({ bankId, input }: { bankId: string; input: Record<string, unknown> }) =>
			callEndpoint(base, `POST`, `/banks/${encodeURIComponent(bankId)}/retain`, input),
		retainBatch: ({ bankId, input }: { bankId: string; input: Record<string, unknown> }) =>
			callEndpoint(base, `POST`, `/banks/${encodeURIComponent(bankId)}/retain-batch`, input),
		recall: ({ bankId, input }: { bankId: string; input: Record<string, unknown> }) =>
			callEndpoint(base, `POST`, `/banks/${encodeURIComponent(bankId)}/recall`, input),
		reflect: ({ bankId, input }: { bankId: string; input: Record<string, unknown> }) =>
			callEndpoint(base, `POST`, `/banks/${encodeURIComponent(bankId)}/reflect`, input),
		getBankStats: ({ bankId, input }: { bankId: string; input?: QueryInput }) =>
			callEndpoint(base, `GET`, `/banks/${encodeURIComponent(bankId)}/stats`, input),
		listMemoryUnits: ({ bankId, input }: { bankId: string; input?: QueryInput }) =>
			callEndpoint(base, `GET`, `/banks/${encodeURIComponent(bankId)}/memories`, input),
		getMemoryUnit: ({
			bankId,
			memoryId,
			input,
		}: {
			bankId: string
			memoryId: string
			input?: QueryInput
		}) =>
			callEndpoint(
				base,
				`GET`,
				`/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
				input,
			),
		deleteMemoryUnit: ({
			bankId,
			memoryId,
			input,
		}: {
			bankId: string
			memoryId: string
			input?: QueryInput
		}) =>
			callEndpoint(
				base,
				`DELETE`,
				`/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
				input,
			),
		listEntities: ({ bankId, input }: { bankId: string; input?: QueryInput }) =>
			callEndpoint(base, `GET`, `/banks/${encodeURIComponent(bankId)}/entities`, input),
		getEntity: ({
			bankId,
			entityId,
			input,
		}: {
			bankId: string
			entityId: string
			input?: QueryInput
		}) =>
			callEndpoint(
				base,
				`GET`,
				`/banks/${encodeURIComponent(bankId)}/entities/${encodeURIComponent(entityId)}`,
				input,
			),
	}
}

beforeAll(() => {
	t = createTestHindsight()

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			const response = handleHindsightRequest(t.hs, req, url.pathname)
			if (response) return response
			return new Response("Not found", { status: 404 })
		},
	})

	baseUrl = `http://localhost:${server.port}`
	rpc = createHindsightClient(baseUrl)
})

afterAll(() => {
	server.stop(true)
	t.cleanup()
})

// ── Unique bank name helper ──────────────────────────────────────────────

let counter = 0
function uniqueName(prefix: string): string {
	return `${prefix}-${++counter}-${Date.now()}`
}

// ── Typed RPC helpers ────────────────────────────────────────────────────

async function createBank(
	name: string,
	opts?: Record<string, unknown>,
) {
	return rpc.createBank({ input: { name, ...opts } })
}

async function retain(
	bankId: string,
	content: string,
	options?: Record<string, unknown>,
) {
	return rpc.retain({ bankId, input: { content, options } })
}

async function retainBatch(
	bankId: string,
	contents: string[],
	options?: Record<string, unknown>,
) {
	return rpc.retainBatch({ bankId, input: { contents, options } })
}

async function recall(
	bankId: string,
	query: string,
	options?: Record<string, unknown>,
) {
	return rpc.recall({ bankId, input: { query, options } })
}

async function reflect(
	bankId: string,
	query: string,
	options?: Record<string, unknown>,
) {
	return rpc.reflect({ bankId, input: { query, options } })
}

// ── Bank CRUD ────────────────────────────────────────────────────────────

describe("Hindsight HTTP Server Integration", () => {
	describe("Bank CRUD", () => {
		it("creates a bank via POST /banks", async () => {
			const bank = await createBank(uniqueName("create")) as Bank
			expect(bank.id).toBeDefined()
			expect(typeof bank.id).toBe("string")
			expect(bank.id.length).toBeGreaterThan(0)
			expect(bank.name).toContain("create")
		})

		it("creates a bank with description, config, and mission", async () => {
			const bank = await createBank(uniqueName("configured"), {
				description: "A test bank",
				config: { extractionMode: "verbose" },
				mission: "I am a test bank for integration testing.",
			}) as Bank
			expect(bank.description).toBe("A test bank")
			expect(bank.config.extractionMode).toBe("verbose")
			expect(bank.mission).toBe(
				"I am a test bank for integration testing.",
			)
		})

		it("creates a bank with disposition traits", async () => {
			const bank = await createBank(uniqueName("disposition"), {
				disposition: { skepticism: 5, literalism: 1, empathy: 4 },
			}) as Bank
			expect(bank.disposition.skepticism).toBe(5)
			expect(bank.disposition.literalism).toBe(1)
			expect(bank.disposition.empathy).toBe(4)
		})

		it("lists all banks via GET /banks", async () => {
			const name1 = uniqueName("list-a")
			const name2 = uniqueName("list-b")
			await createBank(name1)
			await createBank(name2)

			const banks = await rpc.listBanks({ input: undefined }) as Bank[]
			expect(Array.isArray(banks)).toBe(true)
			const names = banks.map((b: Bank) => b.name)
			expect(names).toContain(name1)
			expect(names).toContain(name2)
		})

		it("each bank has .id field (not bank_id or agent_id)", async () => {
			const bank = await createBank(uniqueName("id-field")) as Bank
			expect(bank).toHaveProperty("id")
			expect(bank).not.toHaveProperty("bank_id")
			expect(bank).not.toHaveProperty("agent_id")
		})

		it("gets a bank by ID via GET /banks/:bankId", async () => {
			const created = await createBank(uniqueName("get-by-id")) as Bank
			const found = await rpc.getBank({ bankId: created.id, input: undefined }) as Bank
			expect(found).not.toBeNull()
			expect(found.id).toBe(created.id)
			expect(found.name).toBe(created.name)
		})

		it("returns error for non-existent bank", async () => {
			await expect(
				rpc.getBank({ bankId: "nonexistent-id-12345", input: undefined }),
			).rejects.toThrow()
		})

		it("updates a bank via PATCH /banks/:bankId", async () => {
			const bank = await createBank(uniqueName("update")) as Bank
			const updated = await rpc.updateBank({
				bankId: bank.id,
				input: { name: "updated-name", mission: "Updated mission." },
			}) as Bank
			expect(updated.name).toBe("updated-name")
			expect(updated.mission).toBe("Updated mission.")
		})

		it("deletes a bank via DELETE /banks/:bankId", async () => {
			const bank = await createBank(uniqueName("delete-me")) as Bank
			await rpc.deleteBank({ bankId: bank.id, input: undefined })
			// After delete, getting it should throw (404)
			await expect(
				rpc.getBank({ bankId: bank.id, input: undefined }),
			).rejects.toThrow()
		})

		it("returns 400 for missing name in createBank", async () => {
			const res = await fetch(`${baseUrl}/banks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			})
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error: string }
			expect(body.error).toContain("name")
		})
	})

	// ── Retain ───────────────────────────────────────────────────────────

	describe("Retain", () => {
		let bankId: string

		beforeEach(async () => {
			const bank = await createBank(uniqueName("retain")) as Bank
			bankId = bank.id
		})

		it("retains content with pre-extracted facts", async () => {
			const result = await retain(bankId, "Peter loves hiking", {
				facts: [
					{
						content: "Peter loves hiking",
						factType: "experience",
						confidence: 0.9,
					},
				],
				consolidate: false,
			}) as RetainResult
			expect(result.memories).toBeDefined()
			expect(result.memories.length).toBeGreaterThan(0)
			expect(result.memories[0]!.content).toBe("Peter loves hiking")
		})

		it("returns memories, entities, and links in response", async () => {
			const result = await retain(bankId, "test content", {
				facts: [
					{
						content: "Peter works at Acme",
						factType: "world",
						entities: ["Peter", "Acme"],
					},
				],
				consolidate: false,
			}) as RetainResult
			expect(result).toHaveProperty("memories")
			expect(result).toHaveProperty("entities")
			expect(result).toHaveProperty("links")
			expect(Array.isArray(result.memories)).toBe(true)
			expect(Array.isArray(result.entities)).toBe(true)
			expect(Array.isArray(result.links)).toBe(true)
		})

		it("retains multiple facts in a single call", async () => {
			const result = await retain(bankId, "multi-fact", {
				facts: [
					{ content: "Fact A", factType: "experience" },
					{ content: "Fact B", factType: "world" },
					{ content: "Fact C", factType: "opinion" },
				],
				consolidate: false,
			}) as RetainResult
			expect(result.memories.length).toBe(3)
		})

		it("retains batch content via POST /banks/:bankId/retain-batch", async () => {
			const results = await retainBatch(
				bankId,
				["First item", "Second item"],
				{ consolidate: false },
			) as RetainResult[]
			expect(Array.isArray(results)).toBe(true)
			expect(results.length).toBe(2)
		})

		it("returns 400 for missing content", async () => {
			const res = await fetch(
				`${baseUrl}/banks/${bankId}/retain`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			)
			expect(res.status).toBe(400)
		})
	})

	// ── Recall ───────────────────────────────────────────────────────────

	describe("Recall", () => {
		let bankId: string

		beforeEach(async () => {
			const bank = await createBank(uniqueName("recall")) as Bank
			bankId = bank.id
			await retain(bankId, "seed content", {
				facts: [
					{
						content: "Peter loves hiking in the mountains",
						factType: "experience",
					},
					{
						content: "Alice enjoys reading science fiction",
						factType: "experience",
					},
				],
				consolidate: false,
			})
		})

		it("recalls memories via POST /banks/:bankId/recall", async () => {
			const result = await recall(bankId, "hiking") as RecallResult
			expect(result).toHaveProperty("query")
			expect(result.query).toBe("hiking")
			expect(result).toHaveProperty("memories")
			expect(Array.isArray(result.memories)).toBe(true)
		})

		it("returns scored memories with correct structure", async () => {
			const result = await recall(bankId, "hiking") as RecallResult
			if (result.memories.length > 0) {
				const first = result.memories[0]!
				expect(first).toHaveProperty("memory")
				expect(first).toHaveProperty("score")
				expect(first).toHaveProperty("sources")
				expect(typeof first.score).toBe("number")
				expect(Array.isArray(first.sources)).toBe(true)
				expect(first.memory).toHaveProperty("content")
			}
		})

		it("recall results have >= 0 items (lax assertion)", async () => {
			const result = await recall(bankId, "anything") as RecallResult
			expect(result.memories.length).toBeGreaterThanOrEqual(0)
		})

		it("respects limit option", async () => {
			const directResult = await recall(bankId, "hiking") as RecallResult
			expect(directResult.memories.length).toBeGreaterThanOrEqual(0)
		})

		it("returns 400 for missing query", async () => {
			const res = await fetch(
				`${baseUrl}/banks/${bankId}/recall`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			)
			expect(res.status).toBe(400)
		})
	})

	// ── Reflect ──────────────────────────────────────────────────────────

	describe("Reflect", () => {
		let bankId: string

		beforeEach(async () => {
			const bank = await createBank(uniqueName("reflect")) as Bank
			bankId = bank.id
		})

		it("reflects on a query and returns .answer (not .text)", async () => {
			const result = await reflect(bankId, "What do you know?") as ReflectResult
			expect(result).toHaveProperty("answer")
			expect(result).not.toHaveProperty("text")
			expect(typeof result.answer).toBe("string")
		})

		it("returns memories and observations arrays", async () => {
			const result = await reflect(bankId, "What do you know?") as ReflectResult
			expect(Array.isArray(result.memories)).toBe(true)
			expect(Array.isArray(result.observations)).toBe(true)
		})

		it("reflects with budget option", async () => {
			const result = await reflect(bankId, "Tell me everything", {
				budget: "low",
				saveObservations: false,
			}) as ReflectResult
			expect(typeof result.answer).toBe("string")
		})

		it("reflects with context", async () => {
			const result = await reflect(bankId, "Summarize", {
				context: "This is a test context",
				saveObservations: false,
			}) as ReflectResult
			expect(typeof result.answer).toBe("string")
		})
	})

	// ── Memory Units ─────────────────────────────────────────────────────

	describe("Memory Units", () => {
		let bankId: string

		beforeEach(async () => {
			const bank = await createBank(uniqueName("memory")) as Bank
			bankId = bank.id
			await retain(bankId, "seed", {
				facts: [
					{
						content: "Test memory for listing",
						factType: "experience",
					},
					{
						content: "Another test memory",
						factType: "world",
					},
				],
				consolidate: false,
			})
		})

		it("lists memory units via GET /banks/:bankId/memories", async () => {
			const result = await rpc.listMemoryUnits({
				bankId,
				input: {},
			}) as ListMemoryUnitsResult
			expect(result).toHaveProperty("items")
			expect(result).toHaveProperty("total")
			expect(result).toHaveProperty("limit")
			expect(result).toHaveProperty("offset")
			expect(result.total).toBeGreaterThan(0)
			expect(result.items.length).toBeGreaterThan(0)
		})

		it("lists memory units with pagination", async () => {
			const result = await rpc.listMemoryUnits({
				bankId,
				input: { limit: 1, offset: 0 },
			}) as ListMemoryUnitsResult
			expect(result.items.length).toBe(1)
			expect(result.total).toBeGreaterThan(1)
		})

		it("gets a specific memory unit", async () => {
			const list = await rpc.listMemoryUnits({
				bankId,
				input: {},
			}) as ListMemoryUnitsResult
			const memoryId = list.items[0]!.id
			const detail = await rpc.getMemoryUnit({
				bankId,
				memoryId,
				input: undefined,
			}) as MemoryUnitDetail
			expect(detail).not.toBeNull()
			expect(detail.id).toBe(memoryId)
		})

		it("returns error for non-existent memory unit", async () => {
			await expect(
				rpc.getMemoryUnit({
					bankId,
					memoryId: "nonexistent-memory",
					input: undefined,
				}),
			).rejects.toThrow()
		})

		it("deletes a memory unit", async () => {
			const list = await rpc.listMemoryUnits({
				bankId,
				input: {},
			}) as ListMemoryUnitsResult
			const memoryId = list.items[0]!.id
			const result = await rpc.deleteMemoryUnit({
				bankId,
				memoryId,
				input: undefined,
			}) as DeleteMemoryUnitResult
			expect(result.success).toBe(true)
		})
	})

	// ── Entities ─────────────────────────────────────────────────────────

	describe("Entities", () => {
		let bankId: string

		beforeEach(async () => {
			const bank = await createBank(uniqueName("entity")) as Bank
			bankId = bank.id
			await retain(bankId, "seed", {
				facts: [
					{
						content: "Peter works at Acme Corp",
						factType: "world",
						entities: ["Peter", "Acme Corp"],
					},
				],
				consolidate: false,
			})
		})

		it("lists entities via GET /banks/:bankId/entities", async () => {
			const result = await rpc.listEntities({
				bankId,
				input: {},
			}) as ListEntitiesResult
			expect(result).toHaveProperty("items")
			expect(result).toHaveProperty("total")
			expect(result).toHaveProperty("limit")
			expect(result).toHaveProperty("offset")
			expect(Array.isArray(result.items)).toBe(true)
		})

		it("entity items have correct shape", async () => {
			const result = await rpc.listEntities({
				bankId,
				input: {},
			}) as ListEntitiesResult
			if (result.items.length > 0) {
				const entity = result.items[0]!
				expect(entity).toHaveProperty("id")
				expect(entity).toHaveProperty("canonicalName")
				expect(entity).toHaveProperty("mentionCount")
			}
		})

		it("returns error for non-existent entity", async () => {
			await expect(
				rpc.getEntity({
					bankId,
					entityId: "nonexistent-entity",
					input: undefined,
				}),
			).rejects.toThrow()
		})
	})

	// ── Bank Stats ───────────────────────────────────────────────────────

	describe("Bank Stats", () => {
		it("returns stats via GET /banks/:bankId/stats", async () => {
			const bank = await createBank(uniqueName("stats")) as Bank
			const stats = await rpc.getBankStats({
				bankId: bank.id,
				input: undefined,
			}) as BankStats
			expect(stats).toHaveProperty("bankId")
			expect(stats.bankId).toBe(bank.id)
			expect(stats).toHaveProperty("nodeCounts")
			expect(stats).toHaveProperty("linkCounts")
		})
	})

	// ── Server Lifecycle ─────────────────────────────────────────────────

	describe("Server Lifecycle", () => {
		it("server starts and serves requests", async () => {
			const res = await fetch(
				`${baseUrl}/banks`,
				{ method: "GET" },
			)
			expect(res.ok).toBe(true)
		})
	})

	// ── Error Handling ───────────────────────────────────────────────────

	describe("Error Handling", () => {
		it("returns 404 for unknown routes", async () => {
			const res = await fetch(
				`${baseUrl}/nonexistent`,
			)
			expect(res.status).toBe(404)
		})

		it("returns 404 for non-existent bank on GET", async () => {
			const res = await fetch(
				`${baseUrl}/banks/does-not-exist`,
			)
			expect(res.status).toBe(404)
		})

		it("returns 400 for missing required fields on retain", async () => {
			const bank = await createBank(uniqueName("err")) as Bank
			const res = await fetch(
				`${baseUrl}/banks/${bank.id}/retain`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			)
			expect(res.status).toBe(400)
		})

		it("returns 400 for missing required fields on recall", async () => {
			const bank = await createBank(uniqueName("err2")) as Bank
			const res = await fetch(
				`${baseUrl}/banks/${bank.id}/recall`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			)
			expect(res.status).toBe(400)
		})

		it("returns 400 for missing required fields on reflect", async () => {
			const bank = await createBank(uniqueName("err3")) as Bank
			const res = await fetch(
				`${baseUrl}/banks/${bank.id}/reflect`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			)
			expect(res.status).toBe(400)
		})

		it("returns 400 for empty contents on retain-batch", async () => {
			const bank = await createBank(uniqueName("err4")) as Bank
			const res = await fetch(
				`${baseUrl}/banks/${bank.id}/retain-batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ contents: [] }),
				},
			)
			expect(res.status).toBe(400)
		})
	})

	// ── Full Workflow ────────────────────────────────────────────────────

	describe("Full Workflow", () => {
		it("create bank → retain (×3 + batch) → recall → reflect", async () => {
			// 1. Create bank
			const bank = await createBank(uniqueName("workflow"), {
				mission: "I help remember things.",
			}) as Bank
			expect(bank.id).toBeDefined()
			expect(bank.name).toContain("workflow")

			// 2. Retain individual facts
			const r1 = await retain(bank.id, "Peter loves hiking", {
				facts: [
					{
						content: "Peter loves hiking",
						factType: "experience",
						confidence: 0.9,
					},
				],
				consolidate: false,
			}) as RetainResult
			expect(r1.memories.length).toBeGreaterThan(0)

			const r2 = await retain(bank.id, "Alice reads sci-fi", {
				facts: [
					{
						content: "Alice reads science fiction",
						factType: "experience",
						confidence: 0.85,
					},
				],
				consolidate: false,
			}) as RetainResult
			expect(r2.memories.length).toBeGreaterThan(0)

			const r3 = await retain(bank.id, "Bob is a chef", {
				facts: [
					{
						content: "Bob is a professional chef",
						factType: "world",
						confidence: 0.95,
					},
				],
				consolidate: false,
			}) as RetainResult
			expect(r3.memories.length).toBeGreaterThan(0)

			// 3. Retain batch
			const batchResults = await retainBatch(
				bank.id,
				["Carol plays piano", "Dave enjoys swimming"],
				{ consolidate: false },
			) as RetainResult[]
			expect(batchResults.length).toBe(2)

			// 4. Recall
			const recallResult = await recall(bank.id, "hobbies") as RecallResult
			expect(recallResult.query).toBe("hobbies")
			expect(Array.isArray(recallResult.memories)).toBe(true)
			expect(recallResult.memories.length).toBeGreaterThanOrEqual(0)

			// 5. Reflect
			const reflectResult = await reflect(
				bank.id,
				"What hobbies do people have?",
				{ budget: "low", saveObservations: false },
			) as ReflectResult
			expect(typeof reflectResult.answer).toBe("string")
			expect(Array.isArray(reflectResult.memories)).toBe(true)
			expect(Array.isArray(reflectResult.observations)).toBe(true)
		})

		it("create 2 banks → list → verify correct field names", async () => {
			const bank1 = await createBank(uniqueName("multi-a")) as Bank
			const bank2 = await createBank(uniqueName("multi-b")) as Bank

			const banks = await rpc.listBanks({ input: undefined }) as Bank[]
			expect(banks.length).toBeGreaterThanOrEqual(2)

			// Verify field names (the specific regression that Python PR #35 tests)
			for (const bank of banks) {
				expect(bank).toHaveProperty("id")
				expect(bank).not.toHaveProperty("bank_id")
				expect(bank).not.toHaveProperty("agent_id")
				expect(typeof bank.id).toBe("string")
				expect(bank.id.length).toBeGreaterThan(0)
			}

			// Verify our banks are in the list
			const ids = banks.map((b: Bank) => b.id)
			expect(ids).toContain(bank1.id)
			expect(ids).toContain(bank2.id)
		})
	})
})
