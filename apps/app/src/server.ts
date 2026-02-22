import { resolve } from "node:path";
import { createServerContext, handleDurableStreamRequest } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlEngine } from "@ellie/db";
import { env } from "@ellie/env/server";
import { createAgentProcedureHandlers } from "./routes/agent";
import { dispatchAppApiRequest } from "./routes/dispatch";
import { dispatchHttpRoute } from "./routes/http";
import { AgentManager } from "./agent/manager";
import { anthropicText, type AnthropicChatModel } from "@tanstack/ai-anthropic";
import { appRouter } from "@ellie/router";

const parsedUrl = new URL(env.API_BASE_URL);
const port = parsedUrl.port !== "" ? Number(parsedUrl.port) : parsedUrl.protocol === "https:" ? 443 : 80;
const { DATA_DIR } = env;

console.log(`[server] DATA_DIR=${DATA_DIR}`);

const engine = new JsonlEngine(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);

// Register stream schemas from the router for JSONL enforcement
engine.registerRouter(appRouter);

const durableStore = new DurableStore(engine);
export const ctx = createServerContext({ store: durableStore });

// ── Agent manager ────────────────────────────────────────────────
// Initialized eagerly at startup. Requires ANTHROPIC_API_KEY in env.
const agentManager: AgentManager | null = env.ANTHROPIC_API_KEY
  ? new AgentManager(durableStore, {
      adapter: anthropicText(env.ANTHROPIC_MODEL as AnthropicChatModel),
      systemPrompt: "You are a helpful assistant.",
    })
  : null;

const procedureHandlers = agentManager
  ? createAgentProcedureHandlers(agentManager)
  : {}

// ── Studio frontend ───────────────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_PUBLIC = resolve(import.meta.dir, "../../react/public");

// Import index.html through Bun's HTML bundler.
// In dev (`--hot`): Bun injects HMR client, bundles TSX on the fly.
// In production: pre-bundled with all assets.
const html = await import(resolve(STUDIO_PUBLIC, "index.html"));
const manifestPath = resolve(STUDIO_PUBLIC, "manifest.json");

// ── Request handler ───────────────────────────────────────────────

function logRequest(method: string, pathname: string, status: number): void {
  const isPolling =
    (method === "GET" && status === 304) ||
    (method === "PUT" && status === 200);
  const tag = isPolling ? "[poll]" : "[server]";

  console.log(`${tag} ${method} ${pathname} ${status}`);
}

async function fetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const routeResponse = await dispatchHttpRoute(req, path, {
    connectedClients: ctx.activeSSEResponses.size + ctx.activeLongPollRequests,
    manifestPath,
  });
  if (routeResponse) {
    logRequest(req.method, path, routeResponse.status);
    return routeResponse;
  }

  const apiResponse = await dispatchAppApiRequest(req, path, {
    procedureHandlers,
    agentProceduresEnabled: agentManager !== null,
    handleStreamRequest: (request, pathname) =>
      handleDurableStreamRequest(ctx, request, pathname),
  })
  if (apiResponse) {
    logRequest(req.method, path, apiResponse.status);
    return apiResponse;
  }

  // Non-API routes fall through to SPA handler via `routes`
  return new Response(null, { status: 404 });
}

// ── Start server ──────────────────────────────────────────────────
// Single HTML entry = SPA fallback for all non-API routes
Bun.serve({
  routes: {
    "/": html.default,
  },
  fetch,
  port,
});

console.log(`[server] listening on http://localhost:${port}`);
