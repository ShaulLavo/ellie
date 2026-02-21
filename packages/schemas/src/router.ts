/**
 * AppRouter type definition and shared stream schemas.
 *
 * Defines the full router shape used by `@ellie/router` (runtime),
 * `@ellie/hindsight/server` (handler types), and client apps.
 *
 * Lives in `@ellie/schemas` to break the circular dependency between
 * `@ellie/router` and `@ellie/hindsight`.
 */

import * as v from "valibot"
import type { CollectionDef, StreamDef, ProcedureDef } from "@ellie/rpc"
import { agentMessageSchema, agentEventSchema } from "./agent"
import {
  bankSchema,
  createBankInputSchema,
  updateBankInputSchema,
  retainInputSchema,
  retainBatchInputSchema,
  recallInputSchema,
  reflectInputSchema,
  listMemoryUnitsInputSchema,
  listEntitiesInputSchema,
  retainResultSchema,
  recallResultSchema,
  reflectResultSchema,
  bankStatsSchema,
  listMemoryUnitsResultSchema,
  memoryUnitDetailSchema,
  deleteMemoryUnitResultSchema,
  listEntitiesResultSchema,
  entityDetailSchema,
  voidSchema,
  listBanksOutputSchema,
  retainBatchOutputSchema,
} from "./hindsight"

// ============================================================================
// Stream Schemas
// ============================================================================

export const messageSchema = v.object({
  id: v.string(),
  role: v.picklist([`user`, `assistant`, `system`]),
  content: v.string(),
  createdAt: v.string(),
})

// ============================================================================
// Router Type
// ============================================================================

export type AppRouter = {
  // Streams
  chat: StreamDef<`/chat/:chatId`, { messages: CollectionDef<typeof messageSchema> }>
  agent: StreamDef<`/agent/:chatId`, { messages: CollectionDef<typeof agentMessageSchema> }>
  agentEvents: StreamDef<`/agent/:chatId/events/:runId`, { events: CollectionDef<typeof agentEventSchema> }>
  // Bank CRUD
  createBank: ProcedureDef<`/banks`, typeof createBankInputSchema, typeof bankSchema, "POST">
  listBanks: ProcedureDef<`/banks`, typeof voidSchema, typeof listBanksOutputSchema, "GET">
  getBank: ProcedureDef<`/banks/:bankId`, typeof voidSchema, typeof bankSchema, "GET">
  updateBank: ProcedureDef<`/banks/:bankId`, typeof updateBankInputSchema, typeof bankSchema, "PATCH">
  deleteBank: ProcedureDef<`/banks/:bankId`, typeof voidSchema, typeof voidSchema, "DELETE">
  // Core operations
  retain: ProcedureDef<`/banks/:bankId/retain`, typeof retainInputSchema, typeof retainResultSchema, "POST">
  retainBatch: ProcedureDef<`/banks/:bankId/retain-batch`, typeof retainBatchInputSchema, typeof retainBatchOutputSchema, "POST">
  recall: ProcedureDef<`/banks/:bankId/recall`, typeof recallInputSchema, typeof recallResultSchema, "POST">
  reflect: ProcedureDef<`/banks/:bankId/reflect`, typeof reflectInputSchema, typeof reflectResultSchema, "POST">
  // Stats, memories, entities
  getBankStats: ProcedureDef<`/banks/:bankId/stats`, typeof voidSchema, typeof bankStatsSchema, "GET">
  listMemoryUnits: ProcedureDef<`/banks/:bankId/memories`, typeof listMemoryUnitsInputSchema, typeof listMemoryUnitsResultSchema, "GET">
  getMemoryUnit: ProcedureDef<`/banks/:bankId/memories/:memoryId`, typeof voidSchema, typeof memoryUnitDetailSchema, "GET">
  deleteMemoryUnit: ProcedureDef<`/banks/:bankId/memories/:memoryId`, typeof voidSchema, typeof deleteMemoryUnitResultSchema, "DELETE">
  listEntities: ProcedureDef<`/banks/:bankId/entities`, typeof listEntitiesInputSchema, typeof listEntitiesResultSchema, "GET">
  getEntity: ProcedureDef<`/banks/:bankId/entities/:entityId`, typeof voidSchema, typeof entityDetailSchema, "GET">
}
