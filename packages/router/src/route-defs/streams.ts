import { agentMessageSchema, agentEventSchema } from "@ellie/schemas/agent"
import { messageSchema } from "@ellie/schemas/router"
import { defineStreams } from "./types"

export const streamDefs = defineStreams({
  chat: {
    path: `/chat/:chatId`,
    collections: { messages: messageSchema },
  },
  agent: {
    path: `/agent/:chatId`,
    collections: { messages: agentMessageSchema },
  },
  agentEvents: {
    path: `/agent/:chatId/events/:runId`,
    collections: { events: agentEventSchema },
  },
} as const)
