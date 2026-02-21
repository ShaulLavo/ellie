import { createRouter } from "@ellie/rpc/server"
import { agentMessageSchema, agentEventSchema } from "@ellie/schemas/agent"
import type { Router } from "@ellie/rpc"
import { type AppRouter, messageSchema } from "@ellie/schemas/router"
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
} from "@ellie/schemas/hindsight"

// Re-export type and schemas for consumers
export type { AppRouter }
export { messageSchema }

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
