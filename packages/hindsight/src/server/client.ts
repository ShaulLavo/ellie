/**
 * Typed HTTP client for the Hindsight server routes.
 *
 * Thin fetch-based wrapper that mirrors the route handler API surface.
 * Used primarily by integration tests and can be reused by apps.
 */

import type {
	Bank,
	BankConfig,
	BankStats,
	DeleteMemoryUnitResult,
	DispositionTraits,
	EntityDetail,
	ListEntitiesResult,
	ListMemoryUnitsOptions,
	ListMemoryUnitsResult,
	MemoryUnitDetail,
	RecallOptions,
	RecallResult,
	ReflectOptions,
	ReflectResult,
	RetainBatchItem,
	RetainBatchOptions,
	RetainBatchResult,
	RetainOptions,
	RetainResult,
} from "../types"

export class HindsightClient {
	readonly #baseUrl: string

	constructor(baseUrl: string) {
		this.#baseUrl = baseUrl
	}

	// ── Banks ────────────────────────────────────────────────────────

	async createBank(
		name: string,
		options?: {
			description?: string
			config?: BankConfig
			disposition?: Partial<DispositionTraits>
			mission?: string
		},
	): Promise<Bank> {
		const res = await fetch(`${this.#baseUrl}/banks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, ...options }),
		})
		return this.#jsonOrThrow(res)
	}

	async listBanks(): Promise<Bank[]> {
		const res = await fetch(`${this.#baseUrl}/banks`)
		return this.#jsonOrThrow(res)
	}

	async getBank(bankId: string): Promise<Bank | null> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}`,
		)
		if (res.status === 404) return null
		return this.#jsonOrThrow(res)
	}

	async updateBank(
		bankId: string,
		updates: { name?: string; mission?: string },
	): Promise<Bank> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(updates),
			},
		)
		return this.#jsonOrThrow(res)
	}

	async deleteBank(bankId: string): Promise<void> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}`,
			{ method: "DELETE" },
		)
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Unknown" }))
			throw new Error(
				(err as { error: string }).error || `HTTP ${res.status}`,
			)
		}
	}

	// ── Core operations ──────────────────────────────────────────────

	async retain(
		bankId: string,
		content: string,
		options?: RetainOptions,
	): Promise<RetainResult> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/retain`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content, options }),
			},
		)
		return this.#jsonOrThrow(res)
	}

	async retainBatch(
		bankId: string,
		contents: (string | RetainBatchItem)[],
		options?: RetainBatchOptions,
	): Promise<RetainBatchResult> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/retain-batch`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ contents, options }),
			},
		)
		return this.#jsonOrThrow(res)
	}

	async recall(
		bankId: string,
		query: string,
		options?: RecallOptions,
	): Promise<RecallResult> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/recall`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, options }),
			},
		)
		return this.#jsonOrThrow(res)
	}

	async reflect(
		bankId: string,
		query: string,
		options?: ReflectOptions,
	): Promise<ReflectResult> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/reflect`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, options }),
			},
		)
		return this.#jsonOrThrow(res)
	}

	// ── Inspection ───────────────────────────────────────────────────

	async getBankStats(bankId: string): Promise<BankStats> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/stats`,
		)
		return this.#jsonOrThrow(res)
	}

	async listMemoryUnits(
		bankId: string,
		options?: ListMemoryUnitsOptions,
	): Promise<ListMemoryUnitsResult> {
		const params = new URLSearchParams()
		if (options?.limit != null) params.set("limit", String(options.limit))
		if (options?.offset != null)
			params.set("offset", String(options.offset))
		if (options?.factType) params.set("factType", options.factType)
		if (options?.searchQuery) params.set("searchQuery", options.searchQuery)

		const qs = params.toString()
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/memories${qs ? `?${qs}` : ""}`,
		)
		return this.#jsonOrThrow(res)
	}

	async getMemoryUnit(
		bankId: string,
		memoryId: string,
	): Promise<MemoryUnitDetail | null> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
		)
		if (res.status === 404) return null
		return this.#jsonOrThrow(res)
	}

	async deleteMemoryUnit(
		bankId: string,
		memoryId: string,
	): Promise<DeleteMemoryUnitResult> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
			{ method: "DELETE" },
		)
		return this.#jsonOrThrow(res)
	}

	async listEntities(
		bankId: string,
		options?: { limit?: number; offset?: number },
	): Promise<ListEntitiesResult> {
		const params = new URLSearchParams()
		if (options?.limit != null) params.set("limit", String(options.limit))
		if (options?.offset != null)
			params.set("offset", String(options.offset))

		const qs = params.toString()
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/entities${qs ? `?${qs}` : ""}`,
		)
		return this.#jsonOrThrow(res)
	}

	async getEntity(
		bankId: string,
		entityId: string,
	): Promise<EntityDetail | null> {
		const res = await fetch(
			`${this.#baseUrl}/banks/${encodeURIComponent(bankId)}/entities/${encodeURIComponent(entityId)}`,
		)
		if (res.status === 404) return null
		return this.#jsonOrThrow(res)
	}

	// ── Internal ─────────────────────────────────────────────────────

	async #jsonOrThrow<T>(res: Response): Promise<T> {
		if (!res.ok) {
			const err = await res
				.json()
				.catch(() => ({ error: `HTTP ${res.status}` }))
			throw new Error(
				(err as { error: string }).error || `HTTP ${res.status}`,
			)
		}
		return res.json() as Promise<T>
	}
}
