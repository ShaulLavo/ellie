import { ulid } from "@ellie/utils"
import { eq } from "drizzle-orm"
import { anthropicText } from "@tanstack/ai-anthropic"
import type { AnyTextAdapter } from "@tanstack/ai"
import { createHindsightDB, type HindsightDatabase } from "./db"
import { EmbeddingStore } from "./embedding"
import { retain as retainImpl } from "./retain"
import { recall as recallImpl } from "./recall"
import { reflect as reflectImpl } from "./reflect"
import { consolidate as consolidateImpl } from "./consolidation"
import {
  createMentalModel as createMentalModelImpl,
  getMentalModel as getMentalModelImpl,
  listMentalModels as listMentalModelsImpl,
  updateMentalModel as updateMentalModelImpl,
  deleteMentalModel as deleteMentalModelImpl,
  refreshMentalModel as refreshMentalModelImpl,
} from "./mental-models"
import {
  createDirective as createDirectiveImpl,
  getDirective as getDirectiveImpl,
  listDirectives as listDirectivesImpl,
  updateDirective as updateDirectiveImpl,
  deleteDirective as deleteDirectiveImpl,
} from "./directives"
import type {
  HindsightConfig,
  BankConfig,
  Bank,
  MentalModel,
  CreateMentalModelOptions,
  UpdateMentalModelOptions,
  RefreshMentalModelResult,
  Directive,
  CreateDirectiveOptions,
  UpdateDirectiveOptions,
  RetainOptions,
  RetainResult,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  ConsolidateOptions,
  ConsolidateResult,
  TraceCallback,
  HindsightTrace,
  RerankFunction,
} from "./types"

// ── Default config values ───────────────────────────────────────────────

const HARDCODED_DEFAULTS: Required<BankConfig> = {
  extractionMode: "concise",
  customGuidelines: null,
  enableConsolidation: true,
  reflectBudget: "mid",
  dedupThreshold: 0.92,
}

/**
 * Hindsight — biomimetic agent memory built on SQLite.
 *
 * Three core operations:
 * - **retain(bankId, content)** — Extract and store facts from text
 * - **recall(bankId, query)** — Multi-strategy retrieval (semantic + BM25 + graph + temporal)
 * - **reflect(bankId, query)** — Agentic reasoning over memories with tool calling
 *
 * Plus:
 * - **consolidate(bankId)** — Convert raw facts into durable observations
 * - Mental models — user-curated summaries with freshness tracking
 */
export class Hindsight {
  private readonly hdb: HindsightDatabase
  private readonly memoryVec: EmbeddingStore
  private readonly entityVec: EmbeddingStore
  private readonly modelVec: EmbeddingStore
  private readonly adapter: AnyTextAdapter
  private readonly rerank: RerankFunction | undefined
  private readonly instanceDefaults: BankConfig | undefined
  private readonly onTrace: TraceCallback | undefined

  constructor(config: HindsightConfig) {
    const dims = config.embeddingDimensions ?? 1536

    this.hdb = createHindsightDB(config.dbPath, dims)
    this.adapter = config.adapter ?? anthropicText("claude-haiku-4-5")
    this.rerank = config.rerank
    this.instanceDefaults = config.defaults
    this.onTrace = config.onTrace

    this.memoryVec = new EmbeddingStore(
      this.hdb.sqlite,
      config.embed,
      dims,
      "hs_memory_vec",
    )
    this.entityVec = new EmbeddingStore(
      this.hdb.sqlite,
      config.embed,
      dims,
      "hs_entity_vec",
    )
    this.modelVec = new EmbeddingStore(
      this.hdb.sqlite,
      config.embed,
      dims,
      "hs_mental_model_vec",
    )
  }

  // ── Config resolution ─────────────────────────────────────────────────

  /**
   * Resolve effective config: call-site > bank config > instance defaults > hardcoded defaults
   */
  private resolveConfig(bankId: string): Required<BankConfig> {
    const bankConfig = this.getBankConfigRaw(bankId)
    return {
      ...HARDCODED_DEFAULTS,
      ...stripUndefined(this.instanceDefaults ?? {}),
      ...stripUndefined(bankConfig),
    }
  }

  private getBankConfigRaw(bankId: string): BankConfig {
    const row = this.hdb.db
      .select({ config: this.hdb.schema.banks.config })
      .from(this.hdb.schema.banks)
      .where(eq(this.hdb.schema.banks.id, bankId))
      .get()
    if (!row?.config) return {}
    try {
      return JSON.parse(row.config) as BankConfig
    } catch {
      return {}
    }
  }

  // ── Tracing ───────────────────────────────────────────────────────────

  private async trace<T>(
    operation: HindsightTrace["operation"],
    bankId: string,
    fn: () => Promise<T>,
    extractMetadata: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    const startedAt = Date.now()
    const result = await fn()
    if (this.onTrace) {
      this.onTrace({
        operation,
        bankId,
        startedAt,
        duration: Date.now() - startedAt,
        metadata: extractMetadata(result),
      })
    }
    return result
  }

  // ── Bank management ─────────────────────────────────────────────────

  createBank(name: string, description?: string, config?: BankConfig): Bank {
    const id = ulid()
    const now = Date.now()
    this.hdb.db
      .insert(this.hdb.schema.banks)
      .values({
        id,
        name,
        description: description ?? null,
        config: config ? JSON.stringify(config) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return {
      id,
      name,
      description: description ?? null,
      config: config ?? {},
      createdAt: now,
      updatedAt: now,
    }
  }

  getBank(name: string): Bank | undefined {
    const row = this.hdb.db
      .select()
      .from(this.hdb.schema.banks)
      .where(eq(this.hdb.schema.banks.name, name))
      .get()
    return row ? toBank(row) : undefined
  }

  getBankById(id: string): Bank | undefined {
    const row = this.hdb.db
      .select()
      .from(this.hdb.schema.banks)
      .where(eq(this.hdb.schema.banks.id, id))
      .get()
    return row ? toBank(row) : undefined
  }

  listBanks(): Bank[] {
    return this.hdb.db
      .select()
      .from(this.hdb.schema.banks)
      .all()
      .map(toBank)
  }

  deleteBank(id: string): void {
    // Clean up vectors in virtual tables (CASCADE only handles Drizzle-managed tables)
    const memoryIds = this.hdb.db
      .select({ id: this.hdb.schema.memoryUnits.id })
      .from(this.hdb.schema.memoryUnits)
      .where(eq(this.hdb.schema.memoryUnits.bankId, id))
      .all()
    for (const m of memoryIds) {
      this.memoryVec.delete(m.id)
    }

    const entityIds = this.hdb.db
      .select({ id: this.hdb.schema.entities.id })
      .from(this.hdb.schema.entities)
      .where(eq(this.hdb.schema.entities.bankId, id))
      .all()
    for (const e of entityIds) {
      this.entityVec.delete(e.id)
    }

    const modelIds = this.hdb.db
      .select({ id: this.hdb.schema.mentalModels.id })
      .from(this.hdb.schema.mentalModels)
      .where(eq(this.hdb.schema.mentalModels.bankId, id))
      .all()
    for (const m of modelIds) {
      this.modelVec.delete(m.id)
    }

    // Clean FTS entries
    this.hdb.sqlite.run("DELETE FROM hs_memory_fts WHERE bank_id = ?", [id])

    // Delete the bank row (cascades to SQL tables)
    this.hdb.db
      .delete(this.hdb.schema.banks)
      .where(eq(this.hdb.schema.banks.id, id))
      .run()
  }

  updateBankConfig(bankId: string, config: BankConfig): Bank {
    const bank = this.getBankById(bankId)
    if (!bank) throw new Error(`Bank ${bankId} not found`)

    const existing = this.getBankConfigRaw(bankId)
    const merged = { ...existing, ...stripUndefined(config) }
    const now = Date.now()
    this.hdb.db
      .update(this.hdb.schema.banks)
      .set({ config: JSON.stringify(merged), updatedAt: now })
      .where(eq(this.hdb.schema.banks.id, bankId))
      .run()
    return this.getBankById(bankId)!
  }

  // ── Core operations ─────────────────────────────────────────────────

  async retain(
    bankId: string,
    content: string,
    options?: RetainOptions,
  ): Promise<RetainResult> {
    const cfg = this.resolveConfig(bankId)
    const resolvedOptions: RetainOptions = {
      mode: cfg.extractionMode,
      customGuidelines: cfg.customGuidelines ?? undefined,
      dedupThreshold: cfg.dedupThreshold,
      consolidate: cfg.enableConsolidation,
      ...stripUndefined(options ?? {}),
    }
    return this.trace(
      "retain",
      bankId,
      () =>
        retainImpl(
          this.hdb,
          this.memoryVec,
          this.entityVec,
          this.modelVec,
          this.adapter,
          bankId,
          content,
          resolvedOptions,
          this.rerank,
        ),
      (r) => ({
        memoriesExtracted: r.memories.length,
        entitiesResolved: r.entities.length,
        linksCreated: r.links.length,
      }),
    )
  }

  async recall(
    bankId: string,
    query: string,
    options?: RecallOptions,
  ): Promise<RecallResult> {
    return this.trace(
      "recall",
      bankId,
      () => recallImpl(this.hdb, this.memoryVec, bankId, query, options, this.rerank),
      (r) => ({
        memoriesReturned: r.memories.length,
        limit: options?.limit ?? 10,
      }),
    )
  }

  async reflect(
    bankId: string,
    query: string,
    options?: ReflectOptions,
  ): Promise<ReflectResult> {
    const cfg = this.resolveConfig(bankId)
    const resolvedOptions: ReflectOptions = {
      budget: cfg.reflectBudget,
      ...stripUndefined(options ?? {}),
    }
    return this.trace(
      "reflect",
      bankId,
      () =>
        reflectImpl(
          this.hdb,
          this.memoryVec,
          this.modelVec,
          this.adapter,
          bankId,
          query,
          resolvedOptions,
          this.rerank,
        ),
      (r) => ({
        memoriesAccessed: r.memories.length,
        observationsSaved: r.observations.length,
        answerLength: r.answer.length,
        budget: resolvedOptions.budget,
      }),
    )
  }

  // ── Consolidation ───────────────────────────────────────────────────

  async consolidate(
    bankId: string,
    options?: ConsolidateOptions,
  ): Promise<ConsolidateResult> {
    return this.trace(
      "consolidate",
      bankId,
      () =>
        consolidateImpl(
          this.hdb,
          this.memoryVec,
          this.modelVec,
          this.adapter,
          bankId,
          options,
          this.rerank,
        ),
      (r) => ({
        memoriesProcessed: r.memoriesProcessed,
        observationsCreated: r.observationsCreated,
        observationsUpdated: r.observationsUpdated,
      }),
    )
  }

  // ── Mental models ─────────────────────────────────────────────────

  async createMentalModel(
    bankId: string,
    options: CreateMentalModelOptions,
  ): Promise<MentalModel> {
    return createMentalModelImpl(this.hdb, this.modelVec, bankId, options)
  }

  getMentalModel(bankId: string, id: string): MentalModel | undefined {
    return getMentalModelImpl(this.hdb, bankId, id)
  }

  listMentalModels(bankId: string): MentalModel[] {
    return listMentalModelsImpl(this.hdb, bankId)
  }

  async updateMentalModel(
    bankId: string,
    id: string,
    options: UpdateMentalModelOptions,
  ): Promise<MentalModel> {
    return updateMentalModelImpl(this.hdb, this.modelVec, bankId, id, options)
  }

  deleteMentalModel(bankId: string, id: string): void {
    deleteMentalModelImpl(this.hdb, this.modelVec, bankId, id)
  }

  async refreshMentalModel(
    bankId: string,
    id: string,
  ): Promise<RefreshMentalModelResult> {
    return refreshMentalModelImpl(
      this.hdb,
      this.memoryVec,
      this.modelVec,
      this.adapter,
      bankId,
      id,
      this.rerank,
    )
  }

  // ── Directives ──────────────────────────────────────────────────────

  createDirective(
    bankId: string,
    options: CreateDirectiveOptions,
  ): Directive {
    return createDirectiveImpl(this.hdb, bankId, options)
  }

  getDirective(bankId: string, id: string): Directive | undefined {
    return getDirectiveImpl(this.hdb, bankId, id)
  }

  listDirectives(bankId: string, activeOnly?: boolean): Directive[] {
    return listDirectivesImpl(this.hdb, bankId, activeOnly)
  }

  updateDirective(
    bankId: string,
    id: string,
    options: UpdateDirectiveOptions,
  ): Directive {
    return updateDirectiveImpl(this.hdb, bankId, id, options)
  }

  deleteDirective(bankId: string, id: string): void {
    deleteDirectiveImpl(this.hdb, bankId, id)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    this.hdb.sqlite.close()
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function toBank(row: typeof import("./schema").banks.$inferSelect): Bank {
  let config: BankConfig = {}
  if (row.config) {
    try {
      config = JSON.parse(row.config) as BankConfig
    } catch {
      // malformed JSON → empty config
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Strip undefined keys so they don't overwrite spread defaults */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  }
  return result
}
