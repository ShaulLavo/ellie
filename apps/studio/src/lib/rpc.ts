import { createRpcClient } from "@ellie/streams-rpc/client"
import { env } from "@ellie/env/client"
import { appRouter, type AppRouter } from "@ellie/rpc-router"

// ============================================================================
// RPC Client (singleton)
// ============================================================================

const baseUrl = env.API_BASE_URL

export const rpc = createRpcClient<AppRouter>(appRouter, { baseUrl })

export type { AppRouter }
