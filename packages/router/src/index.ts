import * as v from "valibot"
import { createRouter } from "@ellie/rpc/server"
import { agentMessageSchema, agentEventSchema } from "@ellie/agent/schemas"

// ============================================================================
// Schemas
// ============================================================================

export const messageSchema = v.object({
  id: v.string(),
  role: v.picklist([`user`, `assistant`, `system`]),
  content: v.string(),
  createdAt: v.string(),
})

// ============================================================================
// Router
// ============================================================================

export const appRouter = createRouter()
  .stream(`chat`, `/chat/:chatId`, {
    messages: messageSchema,
  })
  .stream(`agent`, `/agent/:chatId`, {
    messages: agentMessageSchema,
  })
  .stream(`agentEvents`, `/agent/:chatId/events/:runId`, {
    events: agentEventSchema,
  })

export type AppRouter = typeof appRouter[`_def`]
