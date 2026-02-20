import { createRpcClient } from "@ellie/streams-rpc/client"
import { appRouter, type AppRouter } from "../../../app/src/rpc/router"

// ============================================================================
// RPC Client (singleton)
// ============================================================================

const baseUrl = process.env.API_BASE_URL ?? ``

export const rpc = createRpcClient<AppRouter>(appRouter, { baseUrl })

export type { AppRouter }
