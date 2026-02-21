import { messageSchema } from "@ellie/schemas/router"
import { buildRouter } from "./build-router"
import { procedureDefs } from "./route-defs/procedures"
import { streamDefs } from "./route-defs/streams"
import type { RouterFromDefs } from "./route-defs/types"

// Re-export schemas for consumers
export { messageSchema }

export type AppRouter = RouterFromDefs<typeof streamDefs, typeof procedureDefs>

export const appRouter = buildRouter(streamDefs, procedureDefs)
