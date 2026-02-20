import { resolve } from "node:path";
import { createServerContext } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlEngine } from "@ellie/db";
import { handleStreamRequest } from "./routes/streams";

const port = new URL(Bun.env.API_BASE_URL ?? `http://localhost:3000`).port || 80;
const DATA_DIR = Bun.env.DATA_DIR ?? "./data";

console.log(`[server] DATA_DIR=${DATA_DIR}`);

const engine = new JsonlEngine(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);
const durableStore = new DurableStore(engine);
export const ctx = createServerContext({ store: durableStore });

// ── Studio frontend ───────────────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_PUBLIC = resolve(import.meta.dir, "../../studio/public");

// Import index.html through Bun's HTML bundler.
// In dev (`--hot`): Bun injects HMR client, bundles TSX on the fly.
// In production: pre-bundled with all assets.
const html = await import(resolve(STUDIO_PUBLIC, "index.html"));
const manifestPath = resolve(STUDIO_PUBLIC, "manifest.json");

// ── Request handler ───────────────────────────────────────────────

function logRequest(req: Request, status: number): void {
  const url = new URL(req.url);
  const method = req.method;

  const isPolling =
    (method === "GET" && status === 304) ||
    (method === "PUT" && status === 200);
  const tag = isPolling ? "[poll]" : "[server]";

  console.log(`${tag} ${method} ${url.pathname} ${status}`);
}

async function fetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/manifest.json") {
    const file = Bun.file(manifestPath);
    const response = new Response(file, {
      headers: { "Content-Type": "application/manifest+json" },
    });
    logRequest(req, response.status);
    return response;
  }

  const streamResponse = handleStreamRequest(ctx, req, path);
  if (streamResponse) {
    const response = await streamResponse;
    logRequest(req, response.status);
    return response;
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
