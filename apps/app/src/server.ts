import { resolve } from "node:path";
import { createServerContext } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlEngine } from "@ellie/db";
import { handleStreamRequest } from "./routes/streams";

const port = parseInt(Bun.env.PORT ?? `4437`);
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

  let response: Response;

  const streamResponse = handleStreamRequest(ctx, req, path);
  if (streamResponse) {
    response = await streamResponse;
  } else {
    // SPA fallback — serve React app for all non-API routes
    response = new Response(html.default);
  }

  logRequest(req, response.status);
  return response;
}

// ── Start server ──────────────────────────────────────────────────
Bun.serve({ fetch, port });

console.log(`[server] listening on http://localhost:${port}`);
