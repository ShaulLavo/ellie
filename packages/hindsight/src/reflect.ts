/**
 * Agentic reflection over memories with 3-tier hierarchical retrieval.
 *
 * Tier 1 — Mental Models: user-curated summaries with staleness signals
 * Tier 2 — Observations: auto-consolidated durable knowledge with freshness
 * Tier 3 — Raw Facts: individual experiences + world knowledge (ground truth)
 * Utility — get_entity: cross-tier entity lookup
 */

import { chat, streamToText, maxIterations, toolDefinition } from "@ellie/ai"
import { ulid } from "@ellie/utils"
import { eq, and, inArray } from "drizzle-orm"
import * as v from "valibot"
import type { AnyTextAdapter } from "@tanstack/ai"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  ReflectOptions,
  ReflectResult,
  ReflectBudget,
  Freshness,
  ScoredMemory,
  RerankFunction,
  DispositionTraits,
} from "./types"
import { parseLLMJson } from "./sanitize"
import { recall } from "./recall"
import { searchMentalModelsWithStaleness } from "./mental-models"
import { loadDirectivesForReflect } from "./directives"
import {
  getReflectSystemPrompt,
  buildDirectivesSection,
  buildDirectivesReminder,
} from "./prompts"

/** Bank profile passed to reflect for prompt injection */
export interface BankProfile {
  name: string
  mission: string
  disposition: DispositionTraits
}

const BUDGET_ITERATIONS: Record<ReflectBudget, number> = {
  low: 3,
  mid: 5,
  high: 8,
}

const DONE_CALL_PATTERN = /done\s*\(\s*\{.*$/is
const LEAKED_JSON_SUFFIX = /\s*```(?:json)?\s*\{[^}]*(?:"(?:observation_ids|memory_ids|mental_model_ids)"|\})\s*```\s*$/is
const LEAKED_JSON_OBJECT = /\s*\{[^{]*"(?:observation_ids|memory_ids|mental_model_ids|answer)"[^}]*\}\s*$/is
const TRAILING_IDS_PATTERN = /\s*(?:observation_ids|memory_ids|mental_model_ids)\s*[=:]\s*\[.*?\]\s*$/is
const SPECIAL_TOKEN_SUFFIX_PATTERN = /<\|[^|]+?\|>.*$/s

/**
 * @param modelVec - Embedding store for mental models. Pass null to skip
 *   mental model lookup (used during refresh to avoid recursion).
 */
export async function reflect(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore | null,
  adapter: AnyTextAdapter,
  bankId: string,
  query: string,
  options: ReflectOptions = {},
  rerank?: RerankFunction,
  bankProfile?: BankProfile,
): Promise<ReflectResult> {
  const startedAt = Date.now()
  const allMemories: ScoredMemory[] = []
  const toolCalls: NonNullable<ReflectResult["trace"]>["toolCalls"] = []
  const { schema } = hdb

  const budget = options.budget ?? "mid"
  const iterations = options.maxIterations ?? BUDGET_ITERATIONS[budget]

  const trackedToolCall = async <T>(
    tool: string,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const toolStartedAt = Date.now()
    try {
      const output = await fn()
      toolCalls.push({
        tool,
        durationMs: Date.now() - toolStartedAt,
        input,
        outputSize: safeOutputSize(output),
      })
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toolCalls.push({
        tool,
        durationMs: Date.now() - toolStartedAt,
        input,
        outputSize: 0,
        error: message,
      })
      throw error
    }
  }

  // ── Tier 1: search_mental_models ──

  const searchMentalModelsDef = toolDefinition({
    name: "search_mental_models",
    description:
      "Search user-curated mental model summaries. Use FIRST when the question might be covered by an existing mental model. " +
      "If a result has is_stale=true, also search observations or raw facts to verify currency.",
    inputSchema: v.object({
      query: v.pipe(v.string(), v.description("Search query for mental models")),
    }),
  })

  const searchMentalModels = searchMentalModelsDef.server(async (_args) => {
    const args = _args as { query: string }
    return trackedToolCall("search_mental_models", args, async () => {
      if (!modelVec) return []
      return searchMentalModelsWithStaleness(hdb, modelVec, bankId, args.query)
    })
  })

  // ── Tier 2: search_observations ──

  const searchObservationsDef = toolDefinition({
    name: "search_observations",
    description:
      "Search consolidated observations (auto-generated durable knowledge). " +
      "Observations synthesize multiple raw facts — more reliable than individual facts. " +
      "If stale (freshness != 'up_to_date'), ALSO use recall to verify with current raw facts.",
    inputSchema: v.object({
      query: v.pipe(v.string(), v.description("Search query for observations")),
      limit: v.optional(v.pipe(v.number(), v.description("Max results (default 10)"))),
      tags: v.optional(v.array(v.string(), "Filter by tags (merged with session-level tags)")),
    }),
  })

  const searchObservations = searchObservationsDef.server(async (_args) => {
    const args = _args as { query: string; limit?: number; tags?: string[] }
    return trackedToolCall("search_observations", args, async () => {
      const mergedTags = mergeTags(options.tags, args.tags)
      const result = await recall(
        hdb,
        memoryVec,
        bankId,
        args.query,
        {
          limit: args.limit ?? 10,
          factTypes: ["observation"],
          tags: mergedTags,
          tagsMatch: options.tagsMatch,
        },
        rerank,
      )

      allMemories.push(...result.memories)

      return result.memories.map((memory) => {
        const staleness = computeObservationStaleness(
          hdb,
          bankId,
          memory.memory.updatedAt,
        )
        return {
          id: memory.memory.id,
          content: memory.memory.content,
          proofCount: memory.memory.proofCount,
          sourceMemoryIds: memory.memory.sourceMemoryIds ?? [],
          tags: memory.memory.tags,
          score: memory.score,
          ...staleness,
        }
      })
    })
  })

  // ── Tier 3: recall / search_memories alias ──

  const recallInputSchema = v.object({
    query: v.pipe(v.string(), v.description("Search query — be specific and targeted")),
    limit: v.optional(v.number()),
    maxTokens: v.optional(v.number()),
    max_tokens: v.optional(v.number()),
    tags: v.optional(v.array(v.string(), "Filter by tags (merged with session-level tags)")),
  })

  const runRecallTool = async (
    rawArgs: {
      query: string
      limit?: number
      maxTokens?: number
      max_tokens?: number
      tags?: string[]
    },
    toolName: string,
  ) => trackedToolCall(toolName, rawArgs, async () => {
    const mergedTags = mergeTags(options.tags, rawArgs.tags)
    const maxTokenBudget = rawArgs.maxTokens ?? rawArgs.max_tokens
    const result = await recall(
      hdb,
      memoryVec,
      bankId,
      rawArgs.query,
      {
        limit: rawArgs.limit ?? 10,
        maxTokens: maxTokenBudget,
        factTypes: ["experience", "world"],
        tags: mergedTags,
        tagsMatch: options.tagsMatch,
      },
      rerank,
    )

    allMemories.push(...result.memories)

    return result.memories.map((memory) => ({
      id: memory.memory.id,
      content: memory.memory.content,
      factType: memory.memory.factType,
      entities: memory.entities.map((entity) => entity.name),
      score: memory.score,
      occurredAt:
        memory.memory.occurredStart ??
        memory.memory.occurredStart ??
        memory.memory.eventDate ??
        memory.memory.createdAt,
    }))
  })

  const recallDef = toolDefinition({
    name: "recall",
    description:
      "Search raw facts (experiences and world knowledge). Ground truth. " +
      "Use when no mental models or observations exist, they are stale, or you need specific details and supporting evidence.",
    inputSchema: recallInputSchema,
  })
  const recallTool = recallDef.server(async (_args) =>
    runRecallTool(
      _args as {
        query: string
        limit?: number
        maxTokens?: number
        max_tokens?: number
        tags?: string[]
      },
      "recall",
    ))

  const searchMemoriesDef = toolDefinition({
    name: "search_memories",
    description: "Alias for recall. Same behavior, retained for compatibility.",
    inputSchema: recallInputSchema,
  })
  const searchMemories = searchMemoriesDef.server(async (_args) =>
    runRecallTool(
      _args as {
        query: string
        limit?: number
        maxTokens?: number
        max_tokens?: number
        tags?: string[]
      },
      "search_memories",
    ))

  // ── Utility: get_entity ──

  const getEntityDef = toolDefinition({
    name: "get_entity",
    description:
      "Get information about a specific named entity and all associated memories. Works across all tiers.",
    inputSchema: v.object({
      name: v.pipe(v.string(), v.description("Entity name to look up")),
    }),
  })

  const getEntity = getEntityDef.server(async (_args) => {
    const args = _args as { name: string }
    return trackedToolCall("get_entity", args, async () => {
      const entity = hdb.db
        .select()
        .from(schema.entities)
        .where(
          and(
            eq(schema.entities.bankId, bankId),
            eq(schema.entities.name, args.name),
          ),
        )
        .get()

      if (!entity) return { found: false as const }

      const junctions = hdb.db
        .select()
        .from(schema.memoryEntities)
        .where(eq(schema.memoryEntities.entityId, entity.id))
        .all()

      const memoryRows = junctions
        .map((junction) =>
          hdb.db
            .select()
            .from(schema.memoryUnits)
            .where(eq(schema.memoryUnits.id, junction.memoryId))
            .get(),
        )
        .filter(Boolean)

      return {
        found: true as const,
        entity: {
          name: entity.name,
          type: entity.entityType,
          firstSeen: entity.firstSeen,
          lastUpdated: entity.lastUpdated,
        },
        memoryCount: memoryRows.length,
        memories: memoryRows.slice(0, 10).map((memory) => ({
          content: memory!.content,
          factType: memory!.factType,
        })),
      }
    })
  })

  // ── Utility: expand (chunk/document context) ──

  const expandDef = toolDefinition({
    name: "expand",
    description:
      "Expand one or more memory IDs into chunk/document context. " +
      "Use depth='chunk' for local context and depth='document' for full source text.",
    inputSchema: v.object({
      memoryIds: v.optional(v.array(v.string())),
      memory_ids: v.optional(v.array(v.string())),
      depth: v.optional(v.string()),
    }),
  })

  const expand = expandDef.server(async (_args) => {
    const rawArgs = _args as {
      memoryIds?: string[]
      memory_ids?: string[]
      depth?: string
    }
    return trackedToolCall("expand", rawArgs, async () => {
      const memoryIds = normalizeExpandMemoryIds(rawArgs)
      if (memoryIds.length === 0) return { results: [] as Array<Record<string, unknown>> }

      const depth = normalizeExpandDepth(rawArgs.depth)
      const memoryRows = hdb.db
        .select({
          id: schema.memoryUnits.id,
          content: schema.memoryUnits.content,
          chunkId: schema.memoryUnits.chunkId,
          documentId: schema.memoryUnits.documentId,
          factType: schema.memoryUnits.factType,
          sourceText: schema.memoryUnits.sourceText,
        })
        .from(schema.memoryUnits)
        .where(
          and(
            eq(schema.memoryUnits.bankId, bankId),
            inArray(schema.memoryUnits.id, memoryIds),
          ),
        )
        .all()
      if (memoryRows.length === 0) return { results: [] as Array<Record<string, unknown>> }

      const chunkIds = [
        ...new Set(
          memoryRows
            .map((row) => row.chunkId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ]
      const chunkRows =
        chunkIds.length > 0
          ? hdb.db
              .select({
                id: schema.chunks.id,
                content: schema.chunks.content,
                chunkIndex: schema.chunks.chunkIndex,
                documentId: schema.chunks.documentId,
              })
              .from(schema.chunks)
              .where(inArray(schema.chunks.id, chunkIds))
              .all()
          : []
      const chunkMap = new Map(chunkRows.map((row) => [row.id, row]))

      const documentIds = new Set<string>()
      if (depth === "document") {
        for (const memory of memoryRows) {
          if (memory.documentId) documentIds.add(memory.documentId)
          if (!memory.chunkId) continue
          const chunk = chunkMap.get(memory.chunkId)
          if (chunk?.documentId) documentIds.add(chunk.documentId)
        }
      }
      const documentRows =
        documentIds.size > 0
          ? hdb.db
              .select({
                id: schema.documents.id,
                originalText: schema.documents.originalText,
              })
              .from(schema.documents)
              .where(inArray(schema.documents.id, [...documentIds]))
              .all()
          : []
      const documentMap = new Map(documentRows.map((row) => [row.id, row]))
      const memoryMap = new Map(memoryRows.map((row) => [row.id, row]))

      const results: Array<Record<string, unknown>> = []
      for (const memoryId of memoryIds) {
        const memory = memoryMap.get(memoryId)
        if (!memory) continue

        const item: Record<string, unknown> = {
          memory: {
            id: memory.id,
            content: memory.content,
            factType: memory.factType,
            context: memory.sourceText,
            chunkId: memory.chunkId,
            documentId: memory.documentId,
          },
        }

        if (memory.chunkId) {
          const chunk = chunkMap.get(memory.chunkId)
          if (chunk) {
            item.chunk = {
              id: chunk.id,
              text: chunk.content,
              index: chunk.chunkIndex,
              documentId: chunk.documentId,
            }
            if (depth === "document" && chunk.documentId) {
              const document = documentMap.get(chunk.documentId)
              if (document) {
                item.document = {
                  id: document.id,
                  text: document.originalText,
                }
              }
            }
          }
        } else if (depth === "document" && memory.documentId) {
          const document = documentMap.get(memory.documentId)
          if (document) {
            item.document = {
              id: document.id,
              text: document.originalText,
            }
          }
        }

        results.push(item)
      }

      return { results }
    })
  })

  // ── Run the agentic loop ──

  const userMessage = options.context
    ? `${query}\n\nAdditional context: ${options.context}`
    : query

  const activeDirectives = loadDirectivesForReflect(
    hdb,
    bankId,
    options.tags,
    options.tagsMatch,
  )
  const basePrompt = getReflectSystemPrompt(budget)
  const bankIdentity = bankProfile ? buildBankIdentitySection(bankProfile) : ""
  const systemPrompt =
    buildDirectivesSection(activeDirectives) +
    basePrompt +
    bankIdentity +
    buildDirectivesReminder(activeDirectives)

  // Run tool-calling iterations (reserve last iteration for forced text-only)
  // Matches Python: iterations 0..N-2 call LLM with tools, iteration N-1 forces text.
  const toolIterations = Math.max(1, iterations - 1)
  const rawAnswer = await streamToText(
    chat({
      adapter,
      messages: [{ role: "user", content: userMessage }],
      systemPrompts: [systemPrompt],
      tools: [
        searchMentalModels,
        searchObservations,
        recallTool,
        searchMemories,
        getEntity,
        expand,
      ],
      agentLoopStrategy: maxIterations(toolIterations),
    }),
  )

  let answer: string
  if (rawAnswer.trim()) {
    // Model produced a text answer during tool iterations — use it directly
    answer = cleanReflectAnswer(rawAnswer)
  } else {
    // Model exhausted tool iterations without producing text.
    // Force a final text-only call (no tools) to synthesize an answer
    // from whatever was retrieved. Matches Python's FINAL_SYSTEM_PROMPT path.
    const contextSummary = buildToolContextSummary(allMemories)
    const finalPrompt = buildFinalReflectPrompt(
      query,
      contextSummary,
      bankProfile,
      options.context,
    )
    const forcedAnswer = await streamToText(
      chat({
        adapter,
        messages: [{ role: "user", content: finalPrompt }],
        systemPrompts: [FINAL_REFLECT_SYSTEM_PROMPT],
      }),
    )
    answer = cleanReflectAnswer(forcedAnswer)
  }

  // ── Optionally save as observation (stored as memory_unit with factType="observation") ──

  const observationTexts: string[] = []
  if (options.saveObservations !== false && answer.trim()) {
    const observationId = ulid()
    const now = Date.now()
    const sourceIds = [...new Set(allMemories.map((memory) => memory.memory.id))]

    hdb.db
      .insert(schema.memoryUnits)
      .values({
        id: observationId,
        bankId,
        content: answer,
        factType: "observation",
        confidence: 1,
        proofCount: sourceIds.length,
        sourceMemoryIds: JSON.stringify(sourceIds),
        tags: options.tags ? JSON.stringify(options.tags) : null,
        history: JSON.stringify([]),
        consolidatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    hdb.sqlite.run(
      "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
      [observationId, bankId, answer],
    )
    await memoryVec.upsert(observationId, answer)
    observationTexts.push(answer)
  }

  const seenMemoryIds = new Set<string>()
  const uniqueMemories: ScoredMemory[] = []
  for (const memory of allMemories) {
    if (seenMemoryIds.has(memory.memory.id)) continue
    seenMemoryIds.add(memory.memory.id)
    uniqueMemories.push(memory)
  }

  const structuredOutput = options.responseSchema
    ? await generateStructuredOutput(adapter, answer, options.responseSchema)
    : undefined

  return {
    answer,
    memories: uniqueMemories,
    observations: observationTexts,
    structuredOutput,
    trace: {
      startedAt,
      durationMs: Date.now() - startedAt,
      toolCalls,
    },
  }
}

interface ObservationStalenessInfo {
  isStale: boolean
  stalenessReason: string | null
  freshness: Freshness
}

function computeObservationStaleness(
  hdb: HindsightDatabase,
  bankId: string,
  observationUpdatedAt: number,
): ObservationStalenessInfo {
  const pendingCount = countPendingConsolidation(hdb, bankId, observationUpdatedAt)
  if (pendingCount === 0) {
    return { isStale: false, stalenessReason: null, freshness: "up_to_date" }
  }
  if (pendingCount <= 3) {
    return {
      isStale: false,
      stalenessReason: `${pendingCount} memories pending consolidation`,
      freshness: "slightly_stale",
    }
  }
  return {
    isStale: true,
    stalenessReason: `${pendingCount} memories pending consolidation`,
    freshness: "stale",
  }
}

function countPendingConsolidation(
  hdb: HindsightDatabase,
  bankId: string,
  afterTimestamp: number,
): number {
  const result = hdb.sqlite
    .prepare(
      `SELECT COUNT(*) as cnt FROM hs_memory_units
       WHERE bank_id = ?
       AND consolidated_at IS NULL
       AND fact_type IN ('experience', 'world')
       AND created_at > ?`,
    )
    .get(bankId, afterTimestamp) as { cnt: number }
  return result.cnt
}

function mergeTags(sessionTags?: string[], toolTags?: string[]): string[] | undefined {
  if (!sessionTags?.length && !toolTags?.length) return undefined
  return [...new Set([...(sessionTags ?? []), ...(toolTags ?? [])])]
}

function buildBankIdentitySection(profile: BankProfile): string {
  const parts: string[] = ["", `## Memory Bank: ${profile.name}`]

  if (profile.mission) {
    parts.push(`Mission: ${profile.mission}`)
  }

  const { disposition } = profile
  parts.push(
    `Disposition: skepticism=${disposition.skepticism}, literalism=${disposition.literalism}, empathy=${disposition.empathy}`,
  )

  return parts.join("\n")
}

function normalizeExpandMemoryIds(args: {
  memoryIds?: string[]
  memory_ids?: string[]
}): string[] {
  const fromCamel = Array.isArray(args.memoryIds) ? args.memoryIds : []
  const fromSnake = Array.isArray(args.memory_ids) ? args.memory_ids : []
  return [...new Set([...fromCamel, ...fromSnake].filter(Boolean))]
}

function normalizeExpandDepth(depth: string | undefined): "chunk" | "document" {
  return depth?.toLowerCase() === "document" ? "document" : "chunk"
}

// ── Final forced-text prompt (matches Python FINAL_SYSTEM_PROMPT) ──

const FINAL_REFLECT_SYSTEM_PROMPT = `CRITICAL: You MUST ONLY use information from retrieved tool results. NEVER make up names, people, events, or entities.

You are a thoughtful assistant that synthesizes answers from retrieved memories.

Your approach:
- Reason over the retrieved memories to answer the question
- Make reasonable inferences when the exact answer isn't explicitly stated
- Connect related memories to form a complete picture
- Be helpful - if you have related information, use it to give the best possible answer
- ONLY use information from tool results - no external knowledge or guessing

Only say "I don't have information" if the retrieved data is truly unrelated to the question.

FORMATTING: Use proper markdown formatting in your answer:
- Headers (##, ###) for sections
- Lists (bullet or numbered) for enumerations
- Bold/italic for emphasis
- CRITICAL: Always add blank lines before and after block elements

IMPORTANT: Output ONLY the final answer. Do NOT include meta-commentary like "I'll search..." or "Let me analyze...". Do NOT explain your reasoning process. Just provide the direct synthesized answer.`

function buildToolContextSummary(memories: ScoredMemory[]): string {
  if (memories.length === 0) return "No data was retrieved."
  const items = memories.map(
    (m) => `- [${m.memory.factType}] ${m.memory.content}`,
  )
  return items.join("\n")
}

function buildFinalReflectPrompt(
  query: string,
  contextSummary: string,
  bankProfile?: BankProfile,
  additionalContext?: string,
): string {
  const parts: string[] = []

  if (bankProfile) {
    parts.push(`## Memory Bank Context\nName: ${bankProfile.name}`)
    if (bankProfile.mission) {
      parts.push(`Mission: ${bankProfile.mission}`)
    }
  }

  parts.push(`\n## Retrieved Data\n${contextSummary}`)
  parts.push(`\n## Question\n${query}`)

  if (additionalContext) {
    parts.push(`\nAdditional context: ${additionalContext}`)
  }

  parts.push(
    "\n## Instructions\n" +
    "Provide a thoughtful answer by synthesizing and reasoning from the retrieved data above. " +
    "You can make reasonable inferences from the memories, but don't completely fabricate information. " +
    "If the exact answer isn't stated, use what IS stated to give the best possible answer. " +
    "Only say 'I don't have information' if the retrieved data is truly unrelated to the question.\n\n" +
    "IMPORTANT: Output ONLY the final answer. Do NOT include meta-commentary. " +
    "Just provide the direct synthesized answer.",
  )

  return parts.join("\n")
}

function cleanReflectAnswer(text: string): string {
  return _cleanDoneAnswer(_cleanAnswerText(text))
}

export function _cleanAnswerText(text: string): string {
  const source = text ?? ""
  if (!source) return ""
  const cleaned = source.trim().replace(DONE_CALL_PATTERN, "").trim()
  return cleaned || source.trim()
}

export function _cleanDoneAnswer(text: string): string {
  const source = text ?? ""
  if (!source) return ""
  let cleaned = source.trim()
  cleaned = cleaned.replace(LEAKED_JSON_SUFFIX, "").trim()
  cleaned = cleaned.replace(LEAKED_JSON_OBJECT, "").trim()
  cleaned = cleaned.replace(TRAILING_IDS_PATTERN, "").trim()
  return cleaned || source.trim()
}

export function _normalizeToolName(name: string): string {
  let normalized = (name ?? "").trim()
  if (!normalized) return normalized

  if (normalized.startsWith("call=")) {
    normalized = normalized.slice("call=".length).trim()
  }
  if (normalized.startsWith("functions.")) {
    normalized = normalized.slice("functions.".length).trim()
  }
  normalized = normalized.replace(SPECIAL_TOKEN_SUFFIX_PATTERN, "").trim()
  return normalized
}

export function _isDoneTool(name: string): boolean {
  return _normalizeToolName(name) === "done"
}

export interface ReflectAgentToolCallLike {
  id: string
  name: string
  arguments?: Record<string, unknown>
}

export interface ReflectAgentToolCallResultLike {
  toolCalls: ReflectAgentToolCallLike[]
  finishReason?: string
}

export interface ReflectAgentLoopResultLike {
  text: string
  usedMemoryIds: string[]
  iterations: number
}

export async function _runReflectAgentLoopForTesting(input: {
  callWithTools: () => Promise<ReflectAgentToolCallResultLike>
  tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>
  maxIterations?: number
}): Promise<ReflectAgentLoopResultLike> {
  const maxIterations = input.maxIterations ?? 5

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const result = await input.callWithTools()
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : []
    for (const toolCall of toolCalls) {
      const normalized = _normalizeToolName(toolCall.name)
      const args = toolCall.arguments ?? {}

      if (_isDoneTool(normalized)) {
        const answer = typeof args.answer === "string" ? args.answer : ""
        const usedMemoryIds = parseStringArray(args.memory_ids, args.memoryIds)
        return {
          text: _cleanDoneAnswer(answer),
          usedMemoryIds,
          iterations: iteration,
        }
      }

      const tool = input.tools[normalized]
      if (!tool) {
        continue
      }

      try {
        await tool(args)
      } catch {
        // Keep looping to allow recovery on subsequent iterations.
      }
    }
  }

  return {
    text: "",
    usedMemoryIds: [],
    iterations: maxIterations,
  }
}

function parseStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const strings = value.filter((entry): entry is string => typeof entry === "string")
    return strings
  }
  return []
}

async function generateStructuredOutput(
  adapter: AnyTextAdapter,
  answer: string,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!answer.trim()) return null

  try {
    const schemaJson = JSON.stringify(schema, null, 2)
    const text = await streamToText(
      chat({
        adapter,
        systemPrompts: [
          "Extract structured JSON from the provided answer. Return only a JSON object matching the schema.",
        ],
        messages: [
          {
            role: "user",
            content:
              `Answer:\n${answer}\n\n` +
              `JSON Schema:\n${schemaJson}\n\n` +
              "Return only valid JSON.",
          },
        ],
        modelOptions: {
          response_format: { type: "json_object" },
        },
      }),
    )
    const parsed = parseLLMJson<Record<string, unknown> | null>(text, null)
    if (!parsed || typeof parsed !== "object") return null
    return parsed
  } catch {
    return null
  }
}

function safeOutputSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}
