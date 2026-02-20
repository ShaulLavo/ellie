import * as v from "valibot"
import { createRouter } from "@ellie/streams-rpc/server"
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
  .stream(`chat`, `/chat/:chatId`)
    .collection(`messages`, messageSchema)
  .build()

export type AppRouter = typeof appRouter
