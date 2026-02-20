import { createRpcClient } from "@ellie/streams-rpc/client"
import { appRouter, type AppRouter } from "@ellie/rpc-router"

// ============================================================================
// RPC Client (singleton)
// ============================================================================

// Bun statically replaces process.env.API_BASE_URL at build time.
// Empty string = same-origin (relative URLs), which is the default for local dev.
const baseUrl = process.env.API_BASE_URL ?? ``

export const rpc = createRpcClient<AppRouter>(appRouter, { baseUrl })

export type { AppRouter }
