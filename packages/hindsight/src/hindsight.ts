import { ulid } from "@ellie/utils"
import { eq, and, inArray } from "drizzle-orm"
import { anthropicText } from "@tanstack/ai-anthropic"
import type { AnyTextAdapter } from "@tanstack/ai"
import { createHindsightDB, type HindsightDatabase } from "./db"
import { EmbeddingStore } from "./embedding"
import { retain as retainImpl, retainBatch as retainBatchImpl } from "./retain"
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
  DispositionTraits,
  MentalModel,
  CreateMentalModelOptions,
  UpdateMentalModelOptions,
  RefreshMentalModelResult,
  Directive,
  CreateDirectiveOptions,
  UpdateDirectiveOptions,
  RetainOptions,
  RetainBatchOptions,
  RetainBatchItem,
  RetainResult,
  RetainBatchResult,
  RecallOptions,
  RecallResult,
  ReflectOptions,
  ReflectResult,
  ConsolidateOptions,
  ConsolidateResult,
  TraceCallback,
  HindsightTrace,
  RerankFunction,
  DocumentRecord,
  ChunkRecord,
  GraphNode,
  GraphEdge,
  AsyncOperationType,
  AsyncOperationStatus,
  AsyncOperationApiStatus,
  AsyncOperationSummary,
  ListOperationsOptions,
  ListOperationsResult,
  OperationStatusResult,
  SubmitAsyncOperationResult,
  SubmitAsyncRetainResult,
  CancelOperationResult,
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
  private readonly activeOperationTasks = new Map<string, Promise<void>>()
  private readonly cancelledOperations = new Set<string>()

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
      config.embedBatch,
      dims,
      "hs_memory_vec",
    )
    this.entityVec = new EmbeddingStore(
      this.hdb.sqlite,
      config.embed,
      config.embedBatch,
      dims,
      "hs_entity_vec",
    )
    this.modelVec = new EmbeddingStore(
      this.hdb.sqlite,
      config.embed,
      config.embedBatch,
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

  createBank(
    name: string,
    options?: {
      description?: string
      config?: BankConfig
      disposition?: Partial<DispositionTraits>
      mission?: string
    },
  ): Bank {
    const id = ulid()
    const now = Date.now()
    const disposition: DispositionTraits = {
      ...DEFAULT_DISPOSITION,
      ...stripUndefined(options?.disposition ?? {}),
    }
    const mission = options?.mission ?? ""

    this.hdb.db
      .insert(this.hdb.schema.banks)
      .values({
        id,
        name,
        description: options?.description ?? null,
        config: options?.config ? JSON.stringify(options.config) : null,
        disposition: JSON.stringify(disposition),
        mission,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return {
      id,
      name,
      description: options?.description ?? null,
      config: options?.config ?? {},
      disposition,
      mission,
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

  setDisposition(bankId: string, traits: Partial<DispositionTraits>): Bank {
    const bank = this.getBankById(bankId)
    if (!bank) throw new Error(`Bank ${bankId} not found`)

    const merged: DispositionTraits = {
      ...bank.disposition,
      ...stripUndefined(traits),
    }

    // Clamp values to 1-5
    merged.skepticism = clamp(merged.skepticism, 1, 5)
    merged.literalism = clamp(merged.literalism, 1, 5)
    merged.empathy = clamp(merged.empathy, 1, 5)

    const now = Date.now()
    this.hdb.db
      .update(this.hdb.schema.banks)
      .set({ disposition: JSON.stringify(merged), updatedAt: now })
      .where(eq(this.hdb.schema.banks.id, bankId))
      .run()
    return this.getBankById(bankId)!
  }

  setMission(bankId: string, mission: string): Bank {
    const bank = this.getBankById(bankId)
    if (!bank) throw new Error(`Bank ${bankId} not found`)

    const now = Date.now()
    this.hdb.db
      .update(this.hdb.schema.banks)
      .set({ mission, updatedAt: now })
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
    const bank = this.getBankById(bankId)
    const retainProfile = bank
      ? { name: bank.name, mission: bank.mission, disposition: bank.disposition }
      : undefined

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
          retainProfile,
        ),
      (r) => ({
        memoriesExtracted: r.memories.length,
        entitiesResolved: r.entities.length,
        linksCreated: r.links.length,
      }),
    )
  }

  async retainBatch(
    bankId: string,
    contents: string[],
    options?: RetainBatchOptions,
  ): Promise<RetainBatchResult>
  async retainBatch(
    bankId: string,
    contents: RetainBatchItem[],
    options?: RetainBatchOptions,
  ): Promise<RetainBatchResult>
  async retainBatch(
    bankId: string,
    contents: string[] | RetainBatchItem[],
    options?: RetainBatchOptions,
  ): Promise<RetainBatchResult> {
    const cfg = this.resolveConfig(bankId)
    const resolvedOptions: RetainBatchOptions = {
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
        retainBatchImpl(
          this.hdb,
          this.memoryVec,
          this.entityVec,
          this.modelVec,
          this.adapter,
          bankId,
          contents,
          resolvedOptions,
          this.rerank,
        ),
      (results) => ({
        items: contents.length,
        memoriesExtracted: results.reduce(
          (sum, result) => sum + result.memories.length,
          0,
        ),
        entitiesResolved: results.reduce(
          (sum, result) => sum + result.entities.length,
          0,
        ),
        linksCreated: results.reduce((sum, result) => sum + result.links.length, 0),
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
    const bank = this.getBankById(bankId)
    const bankProfile = bank
      ? { name: bank.name, mission: bank.mission, disposition: bank.disposition }
      : undefined

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
          bankProfile,
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
    const bank = this.getBankById(bankId)
    const consProfile = bank
      ? { name: bank.name, mission: bank.mission, disposition: bank.disposition }
      : undefined

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
          consProfile,
        ),
      (r) => ({
        memoriesProcessed: r.memoriesProcessed,
        observationsCreated: r.observationsCreated,
        observationsUpdated: r.observationsUpdated,
        observationsMerged: r.observationsMerged,
        skipped: r.skipped,
      }),
    )
  }

  // ── Async Operations ───────────────────────────────────────────────

  async submitAsyncRetain(
    bankId: string,
    contents: string[] | RetainBatchItem[],
    options?: RetainBatchOptions,
  ): Promise<SubmitAsyncRetainResult> {
    const retainTask = async () => {
      if (contents.length === 0) {
        return this.retainBatch(bankId, [] as string[], options)
      }
      if (typeof contents[0] === "string") {
        return this.retainBatch(bankId, contents as string[], options)
      }
      return this.retainBatch(bankId, contents as RetainBatchItem[], options)
    }

    const result = await this.submitAsyncOperation(
      bankId,
      "retain",
      retainTask,
      { itemsCount: contents.length },
      false,
    )
    return {
      ...result,
      itemsCount: contents.length,
    }
  }

  async submitAsyncConsolidation(
    bankId: string,
    options?: ConsolidateOptions,
  ): Promise<SubmitAsyncOperationResult> {
    return this.submitAsyncOperation(
      bankId,
      "consolidation",
      () => this.consolidate(bankId, options),
      null,
      true,
    )
  }

  async submitAsyncRefreshMentalModel(
    bankId: string,
    mentalModelId: string,
  ): Promise<SubmitAsyncOperationResult> {
    return this.submitAsyncOperation(
      bankId,
      "refresh_mental_model",
      () => this.refreshMentalModel(bankId, mentalModelId),
    )
  }

  listOperations(
    bankId: string,
    options?: ListOperationsOptions,
  ): ListOperationsResult {
    const limit = options?.limit ?? 20
    const offset = options?.offset ?? 0
    const rows = this.hdb.db
      .select()
      .from(this.hdb.schema.asyncOperations)
      .where(eq(this.hdb.schema.asyncOperations.bankId, bankId))
      .all()
      .filter((row) => {
        if (!options?.status) return true
        if (options.status === "pending") {
          return row.status === "pending" || row.status === "processing"
        }
        return row.status === options.status
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    const paged = rows.slice(offset, offset + limit)
    const operations: AsyncOperationSummary[] = paged.map((row) => {
      const metadata = row.resultMetadata
        ? safeJson<Record<string, unknown>>(row.resultMetadata, {})
        : {}
      return {
        id: row.operationId,
        taskType: row.operationType as AsyncOperationType,
        itemsCount:
          typeof metadata.itemsCount === "number" ? metadata.itemsCount : 0,
        documentId:
          typeof metadata.documentId === "string" ? metadata.documentId : null,
        createdAt: row.createdAt,
        status: this.toOperationApiStatus(row.status as AsyncOperationStatus),
        errorMessage: row.errorMessage,
      }
    })

    return {
      total: rows.length,
      operations,
    }
  }

  getOperationStatus(bankId: string, operationId: string): OperationStatusResult {
    const row = this.hdb.db
      .select()
      .from(this.hdb.schema.asyncOperations)
      .where(
        and(
          eq(this.hdb.schema.asyncOperations.operationId, operationId),
          eq(this.hdb.schema.asyncOperations.bankId, bankId),
        ),
      )
      .get()

    if (!row) {
      return {
        operationId,
        status: "not_found",
        operationType: null,
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        errorMessage: null,
        resultMetadata: null,
      }
    }

    return {
      operationId: row.operationId,
      status: this.toOperationApiStatus(row.status as AsyncOperationStatus),
      operationType: row.operationType as AsyncOperationType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      errorMessage: row.errorMessage,
      resultMetadata: row.resultMetadata
        ? safeJson<Record<string, unknown>>(row.resultMetadata, {})
        : null,
    }
  }

  cancelOperation(bankId: string, operationId: string): CancelOperationResult {
    const existing = this.hdb.db
      .select({ operationId: this.hdb.schema.asyncOperations.operationId })
      .from(this.hdb.schema.asyncOperations)
      .where(
        and(
          eq(this.hdb.schema.asyncOperations.operationId, operationId),
          eq(this.hdb.schema.asyncOperations.bankId, bankId),
        ),
      )
      .get()

    if (!existing) {
      return {
        success: false,
        message: `Operation ${operationId} not found`,
        operationId,
        bankId,
      }
    }

    this.hdb.db
      .delete(this.hdb.schema.asyncOperations)
      .where(eq(this.hdb.schema.asyncOperations.operationId, operationId))
      .run()
    this.cancelledOperations.add(operationId)

    return {
      success: true,
      message: `Operation ${operationId} cancelled`,
      operationId,
      bankId,
    }
  }

  private toOperationApiStatus(
    status: AsyncOperationStatus,
  ): Exclude<AsyncOperationApiStatus, "not_found"> {
    if (status === "processing") return "pending"
    return status
  }

  private async submitAsyncOperation(
    bankId: string,
    operationType: AsyncOperationType,
    task: () => Promise<unknown>,
    resultMetadata?: Record<string, unknown> | null,
    dedupeByBank: boolean = false,
  ): Promise<SubmitAsyncOperationResult> {
    if (dedupeByBank) {
      const existing = this.hdb.db
        .select({ operationId: this.hdb.schema.asyncOperations.operationId })
        .from(this.hdb.schema.asyncOperations)
        .where(
          and(
            eq(this.hdb.schema.asyncOperations.bankId, bankId),
            eq(this.hdb.schema.asyncOperations.operationType, operationType),
            eq(this.hdb.schema.asyncOperations.status, "pending"),
          ),
        )
        .get()
      if (existing) {
        return { operationId: existing.operationId, deduplicated: true }
      }
    }

    const operationId = ulid()
    const now = Date.now()
    this.hdb.db
      .insert(this.hdb.schema.asyncOperations)
      .values({
        operationId,
        bankId,
        operationType,
        status: "pending",
        resultMetadata: resultMetadata ? JSON.stringify(resultMetadata) : null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      })
      .run()

    const run = async () => {
      try {
        if (this.cancelledOperations.has(operationId)) return

        const pendingRow = this.hdb.db
          .select({ operationId: this.hdb.schema.asyncOperations.operationId })
          .from(this.hdb.schema.asyncOperations)
          .where(eq(this.hdb.schema.asyncOperations.operationId, operationId))
          .get()
        if (!pendingRow) return

        this.hdb.db
          .update(this.hdb.schema.asyncOperations)
          .set({
            status: "processing",
            updatedAt: Date.now(),
          })
          .where(eq(this.hdb.schema.asyncOperations.operationId, operationId))
          .run()

        await task()

        if (this.cancelledOperations.has(operationId)) return

        const completedAt = Date.now()
        this.hdb.db
          .update(this.hdb.schema.asyncOperations)
          .set({
            status: "completed",
            updatedAt: completedAt,
            completedAt,
            errorMessage: null,
          })
          .where(eq(this.hdb.schema.asyncOperations.operationId, operationId))
          .run()
      } catch (error) {
        if (this.cancelledOperations.has(operationId)) return
        const message =
          error instanceof Error ? error.message : String(error)
        const truncated = message.length > 5000 ? message.slice(0, 5000) : message
        this.hdb.db
          .update(this.hdb.schema.asyncOperations)
          .set({
            status: "failed",
            updatedAt: Date.now(),
            errorMessage: truncated,
          })
          .where(eq(this.hdb.schema.asyncOperations.operationId, operationId))
          .run()
      } finally {
        this.activeOperationTasks.delete(operationId)
        this.cancelledOperations.delete(operationId)
      }
    }

    const taskPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        void run().finally(resolve)
      }, 0)
    })
    this.activeOperationTasks.set(operationId, taskPromise)

    return { operationId }
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
    const bank = this.getBankById(bankId)
    const profile = bank
      ? { name: bank.name, mission: bank.mission, disposition: bank.disposition }
      : undefined

    return refreshMentalModelImpl(
      this.hdb,
      this.memoryVec,
      this.modelVec,
      this.adapter,
      bankId,
      id,
      this.rerank,
      profile,
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

  // ── Documents / Chunks / Graph ─────────────────────────────────────

  listDocuments(
    bankId: string,
    options?: { search?: string; limit?: number; offset?: number },
  ): { items: DocumentRecord[]; total: number; limit: number; offset: number } {
    const limit = options?.limit ?? 100
    const offset = options?.offset ?? 0
    const search = options?.search?.toLowerCase().trim()

    const allRows = this.hdb.db
      .select()
      .from(this.hdb.schema.documents)
      .where(eq(this.hdb.schema.documents.bankId, bankId))
      .all()
      .filter((row) => (search ? row.id.toLowerCase().includes(search) : true))
      .sort((a, b) => b.createdAt - a.createdAt)

    const paged = allRows.slice(offset, offset + limit)
    const items: DocumentRecord[] = paged.map((row) => ({
      id: row.id,
      bankId: row.bankId,
      contentHash: row.contentHash,
      textLength: row.originalText?.length ?? 0,
      metadata: row.metadata ? safeJson<Record<string, unknown>>(row.metadata, {}) : null,
      retainParams: row.retainParams ? safeJson<Record<string, unknown>>(row.retainParams, {}) : null,
      tags: row.tags ? safeJson<string[]>(row.tags, []) : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))

    return {
      items,
      total: allRows.length,
      limit,
      offset,
    }
  }

  getDocument(bankId: string, documentId: string): DocumentRecord | undefined {
    const row = this.hdb.db
      .select()
      .from(this.hdb.schema.documents)
      .where(
        and(
          eq(this.hdb.schema.documents.id, documentId),
          eq(this.hdb.schema.documents.bankId, bankId),
        ),
      )
      .get()
    if (!row) return undefined

    return {
      id: row.id,
      bankId: row.bankId,
      contentHash: row.contentHash,
      textLength: row.originalText?.length ?? 0,
      metadata: row.metadata ? safeJson<Record<string, unknown>>(row.metadata, {}) : null,
      retainParams: row.retainParams ? safeJson<Record<string, unknown>>(row.retainParams, {}) : null,
      tags: row.tags ? safeJson<string[]>(row.tags, []) : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  deleteDocument(bankId: string, documentId: string): boolean {
    this.hdb.db
      .update(this.hdb.schema.memoryUnits)
      .set({ documentId: null, chunkId: null, updatedAt: Date.now() })
      .where(
        and(
          eq(this.hdb.schema.memoryUnits.bankId, bankId),
          eq(this.hdb.schema.memoryUnits.documentId, documentId),
        ),
      )
      .run()

    this.hdb.db
      .delete(this.hdb.schema.documents)
      .where(
        and(
          eq(this.hdb.schema.documents.id, documentId),
          eq(this.hdb.schema.documents.bankId, bankId),
        ),
      )
      .run()

    return true
  }

  getChunk(bankId: string, chunkId: string): ChunkRecord | undefined {
    const row = this.hdb.db
      .select()
      .from(this.hdb.schema.chunks)
      .where(
        and(
          eq(this.hdb.schema.chunks.id, chunkId),
          eq(this.hdb.schema.chunks.bankId, bankId),
        ),
      )
      .get()
    if (!row) return undefined

    return {
      id: row.id,
      documentId: row.documentId,
      bankId: row.bankId,
      index: row.chunkIndex,
      text: row.content,
      createdAt: row.createdAt,
    }
  }

  getGraphData(
    bankId: string,
    options?: { factType?: string; limit?: number },
  ): {
    nodes: GraphNode[]
    edges: GraphEdge[]
    totalUnits: number
    limit: number
  } {
    const limit = options?.limit ?? 1000
    const rows = options?.factType
      ? this.hdb.db
          .select()
          .from(this.hdb.schema.memoryUnits)
          .where(
            and(
              eq(this.hdb.schema.memoryUnits.bankId, bankId),
              eq(this.hdb.schema.memoryUnits.factType, options.factType),
            ),
          )
          .all()
      : this.hdb.db
          .select()
          .from(this.hdb.schema.memoryUnits)
          .where(eq(this.hdb.schema.memoryUnits.bankId, bankId))
          .all()

    const orderedRows = rows
      .sort(
        (a, b) =>
          (b.mentionedAt ?? b.createdAt) - (a.mentionedAt ?? a.createdAt),
      )
      .slice(0, limit)

    const nodes: GraphNode[] = orderedRows.map((row) => ({
      id: row.id,
      content: row.content,
      factType: row.factType as GraphNode["factType"],
      documentId: row.documentId,
      chunkId: row.chunkId,
      tags: row.tags ? safeJson<string[]>(row.tags, []) : [],
      sourceMemoryIds: row.sourceMemoryIds
        ? safeJson<string[]>(row.sourceMemoryIds, [])
        : [],
    }))

    const visibleNodeIds = new Set(nodes.map((node) => node.id))
    if (visibleNodeIds.size === 0) {
      return { nodes, edges: [], totalUnits: rows.length, limit }
    }

    const visibleIds = [...visibleNodeIds]
    const directLinks = this.hdb.db
      .select({
        sourceId: this.hdb.schema.memoryLinks.sourceId,
        targetId: this.hdb.schema.memoryLinks.targetId,
        linkType: this.hdb.schema.memoryLinks.linkType,
        weight: this.hdb.schema.memoryLinks.weight,
      })
      .from(this.hdb.schema.memoryLinks)
      .where(
        and(
          eq(this.hdb.schema.memoryLinks.bankId, bankId),
          inArray(this.hdb.schema.memoryLinks.sourceId, visibleIds),
          inArray(this.hdb.schema.memoryLinks.targetId, visibleIds),
        ),
      )
      .all()

    const sourceToObservations = new Map<string, string[]>()
    for (const node of nodes) {
      for (const sourceId of node.sourceMemoryIds) {
        const existing = sourceToObservations.get(sourceId) ?? []
        existing.push(node.id)
        sourceToObservations.set(sourceId, existing)
      }
    }

    const copiedLinks: GraphEdge[] = []
    for (const link of directLinks) {
      const fromObs = sourceToObservations.get(link.sourceId) ?? []
      const toObs = sourceToObservations.get(link.targetId) ?? []

      for (const obsId of fromObs) {
        if (!visibleNodeIds.has(link.targetId)) continue
        copiedLinks.push({
          sourceId: obsId,
          targetId: link.targetId,
          linkType: link.linkType as GraphEdge["linkType"],
          weight: link.weight,
        })
      }
      for (const obsId of toObs) {
        if (!visibleNodeIds.has(link.sourceId)) continue
        copiedLinks.push({
          sourceId: link.sourceId,
          targetId: obsId,
          linkType: link.linkType as GraphEdge["linkType"],
          weight: link.weight,
        })
      }
    }

    const edges: GraphEdge[] = dedupeGraphEdges([
      ...directLinks.map((link) => ({
        sourceId: link.sourceId,
        targetId: link.targetId,
        linkType: link.linkType as GraphEdge["linkType"],
        weight: link.weight,
      })),
      ...copiedLinks,
    ])

    return {
      nodes,
      edges,
      totalUnits: rows.length,
      limit,
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    this.hdb.sqlite.close()
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

const DEFAULT_DISPOSITION: DispositionTraits = {
  skepticism: 3,
  literalism: 3,
  empathy: 3,
}

function toBank(row: typeof import("./schema").banks.$inferSelect): Bank {
  let config: BankConfig = {}
  if (row.config) {
    try {
      config = JSON.parse(row.config) as BankConfig
    } catch {
      // malformed JSON → empty config
    }
  }

  let disposition: DispositionTraits = { ...DEFAULT_DISPOSITION }
  if (row.disposition) {
    try {
      disposition = { ...DEFAULT_DISPOSITION, ...JSON.parse(row.disposition) }
    } catch {
      // malformed JSON → default disposition
    }
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config,
    disposition,
    mission: row.mission ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function dedupeGraphEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Map<string, GraphEdge>()
  for (const edge of edges) {
    const source = edge.sourceId < edge.targetId ? edge.sourceId : edge.targetId
    const target = edge.sourceId < edge.targetId ? edge.targetId : edge.sourceId
    const key = `${source}:${target}:${edge.linkType}`
    const existing = seen.get(key)
    if (!existing || edge.weight > existing.weight) {
      seen.set(key, edge)
    }
  }
  return [...seen.values()]
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
