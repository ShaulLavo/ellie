import { resolve } from "node:path";
import { createServerContext, handleDurableStreamRequest } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlEngine } from "@ellie/db";
import { env } from "@ellie/env/server";
import { handleAgentRequest } from "./routes/agent";
import { AgentManager } from "./agent/manager";

const parsedUrl = new URL(env.API_BASE_URL);
const port = parsedUrl.port !== "" ? Number(parsedUrl.port) : parsedUrl.protocol === "https:" ? 443 : 80;
const { DATA_DIR } = env;

console.log(`[server] DATA_DIR=${DATA_DIR}`);

const engine = new JsonlEngine(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);
const durableStore = new DurableStore(engine);
export const ctx = createServerContext({ store: durableStore });

// ── Agent manager ────────────────────────────────────────────────
// Lazily initialized — call `setAgentAdapter()` before using agent routes.
let _agentManager: AgentManager | undefined;

/**
 * Set the TanStack AI adapter and initialize the agent manager.
 * Must be called before agent routes are used.
 */
export function setAgentAdapter(adapter: import("@tanstack/ai").AnyTextAdapter): void {
  _agentManager = new AgentManager(durableStore, {
    adapter,
    systemPrompt: "You are a helpful assistant.",
  });
}

export function getAgentManager(): AgentManager {
  if (!_agentManager) throw new Error("Call setAgentAdapter() before using agent routes");
  return _agentManager;
}

// ── Studio frontend ───────────────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_PUBLIC = resolve(import.meta.dir, "../../studio/public");

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

  if (path === "/manifest.json") {
    const file = Bun.file(manifestPath);
    const response = new Response(file, {
      headers: { "Content-Type": "application/manifest+json" },
    });
    logRequest(req.method, path, response.status);
    return response;
  }

  // Agent action routes (prompt, steer, abort, history)
  const agentResponse = handleAgentRequest(getAgentManager(), req, path);
  if (agentResponse) {
    const response = await agentResponse;
    logRequest(req.method, path, response.status);
    return response;
  }

  // /agent/:id/events/:runId — agent events stream (must match before /agent/:id)
  const agentEventsMatch = path.match(/^\/agent\/([^/]+)\/events\/([^/]+)$/);
  if (agentEventsMatch) {
    const [, chatId, runId] = agentEventsMatch;
    const response = await handleDurableStreamRequest(ctx, req, `/agent/${chatId}/events/${runId}`);
    logRequest(req.method, path, response.status);
    return response;
  }

  // /agent/:id — agent messages stream (only for GET/PUT — stream reads)
  if (path.match(/^\/agent\/([^/]+)$/) && (req.method === "GET" || req.method === "PUT")) {
    const id = path.slice("/agent/".length);
    if (id) {
      const response = await handleDurableStreamRequest(ctx, req, `/agent/${id}`);
      logRequest(req.method, path, response.status);
      return response;
    }
  }

  // /chat/:id
  if (path.startsWith("/chat/")) {
    const id = decodeURIComponent(path.slice("/chat/".length));
    if (id) {
      const response = await handleDurableStreamRequest(ctx, req, `/chat/${id}`);
      logRequest(req.method, path, response.status);
      return response;
    }
  }

  // /streams/*
  if (path.startsWith("/streams/")) {
    const rest = decodeURIComponent(path.slice("/streams/".length));
    if (rest) {
      const response = await handleDurableStreamRequest(ctx, req, `/${rest}`);
      logRequest(req.method, path, response.status);
      return response;
    }
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
