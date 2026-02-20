import { createRpcClient } from "@ellie/streams-rpc/client"
import { appRouter, type AppRouter } from "@ellie/rpc-router"

// ============================================================================
// RPC Client (singleton)
// ============================================================================

// Empty string = same-origin (relative URLs)
const baseUrl = process.env.API_BASE_URL ?? ``

export const rpc = createRpcClient<AppRouter>(appRouter, { baseUrl })

export type { AppRouter }
