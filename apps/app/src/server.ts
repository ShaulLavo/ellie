import { Elysia } from "elysia";
import { resolve } from "node:path";
import { createServerContext } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlEngine } from "@ellie/db";
import { streamRoutes } from "./routes/streams";

const port = parseInt(Bun.env.PORT ?? `4437`);
const DATA_DIR = Bun.env.DATA_DIR ?? "./data";

console.log(`[server] DATA_DIR=${DATA_DIR}`);

const engine = new JsonlEngine(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);
const durableStore = new DurableStore(engine);
const ctx = createServerContext({ store: durableStore });

// ── Studio frontend ───────────────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_PUBLIC = resolve(import.meta.dir, "../../studio/public");

// Import index.html through Bun's HTML bundler.
// In dev (`--hot`): Bun injects HMR client, bundles TSX on the fly.
// In production: pre-bundled with all assets.
const html = await import(resolve(STUDIO_PUBLIC, "index.html"));

// ── Build the app ─────────────────────────────────────────────────
const app = new Elysia()
  .onAfterResponse(({ request, response }) => {
    const url = new URL(request.url);
    const status = response instanceof Response ? response.status : response;
    const method = request.method;

    const isPolling =
      (method === "GET" && status === 304) ||
      (method === "PUT" && status === 200);
    const tag = isPolling ? "[poll]" : "[server]";

    console.log(`${tag} ${method} ${url.pathname} ${status}`);
  })
  .use(streamRoutes(ctx))
  // Serve the React app at root and as SPA fallback for client-side routes.
  // API routes above take priority over this catch-all.
  // html.default is a Bun HTMLBundle — Bun's serve() knows how to render it
  // with the bundled JS/CSS and HMR client injected.
  .get("/", html.default)
  .get("/*", html.default);

app.listen(port);

console.log(`[server] listening on http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
