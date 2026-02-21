import * as v from "valibot"
import { createRouter } from "@ellie/rpc/server"
import { agentMessageSchema, agentEventSchema } from "@ellie/agent"
import type { CollectionDef, StreamDef, ProcedureDef, Router } from "@ellie/rpc"
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
} from "@ellie/hindsight/schemas"

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

// ============================================================================
// Router
// ============================================================================

export const appRouter: Router<AppRouter> = createRouter()
  // ── Streams ──
  .stream(`chat`, `/chat/:chatId`, {
    messages: messageSchema,
  })
  .stream(`agent`, `/agent/:chatId`, {
    messages: agentMessageSchema,
  })
  .stream(`agentEvents`, `/agent/:chatId/events/:runId`, {
    events: agentEventSchema,
  })
  // ── Hindsight: Bank CRUD ──
  .post(`createBank`, `/banks`, { input: createBankInputSchema, output: bankSchema })
  .get(`listBanks`, `/banks`, { input: voidSchema, output: listBanksOutputSchema })
  .get(`getBank`, `/banks/:bankId`, { input: voidSchema, output: bankSchema })
  .patch(`updateBank`, `/banks/:bankId`, { input: updateBankInputSchema, output: bankSchema })
  .delete(`deleteBank`, `/banks/:bankId`, { input: voidSchema, output: voidSchema })
  // ── Hindsight: Core operations ──
  .post(`retain`, `/banks/:bankId/retain`, { input: retainInputSchema, output: retainResultSchema })
  .post(`retainBatch`, `/banks/:bankId/retain-batch`, { input: retainBatchInputSchema, output: retainBatchOutputSchema })
  .post(`recall`, `/banks/:bankId/recall`, { input: recallInputSchema, output: recallResultSchema })
  .post(`reflect`, `/banks/:bankId/reflect`, { input: reflectInputSchema, output: reflectResultSchema })
  // ── Hindsight: Stats, memories, entities ──
  .get(`getBankStats`, `/banks/:bankId/stats`, { input: voidSchema, output: bankStatsSchema })
  .get(`listMemoryUnits`, `/banks/:bankId/memories`, { input: listMemoryUnitsInputSchema, output: listMemoryUnitsResultSchema })
  .get(`getMemoryUnit`, `/banks/:bankId/memories/:memoryId`, { input: voidSchema, output: memoryUnitDetailSchema })
  .delete(`deleteMemoryUnit`, `/banks/:bankId/memories/:memoryId`, { input: voidSchema, output: deleteMemoryUnitResultSchema })
  .get(`listEntities`, `/banks/:bankId/entities`, { input: listEntitiesInputSchema, output: listEntitiesResultSchema })
  .get(`getEntity`, `/banks/:bankId/entities/:entityId`, { input: voidSchema, output: entityDetailSchema })
