import { Elysia } from "elysia";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
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

// ── Resolve studio dist path ──────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_DIST = resolve(import.meta.dir, "../../studio/dist");
const hasStudioDist = existsSync(STUDIO_DIST);

if (hasStudioDist) {
  console.log(`[server] serving studio from ${STUDIO_DIST}`);
} else {
  console.log(`[server] studio dist not found at ${STUDIO_DIST}, skipping static files`);
}

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
  // ── Static file serving for studio dist ─────────────────────────
  // Serves the Vite-built React app. API routes above take priority.
  // SPA fallback: any unmatched GET returns index.html for client-side routing.
  .get("/*", ({ params }) => {
    if (!hasStudioDist) return new Response("Not Found", { status: 404 });

    // Try to serve the exact file requested
    const filePath = join(STUDIO_DIST, params["*"]);
    const file = Bun.file(filePath);

    // Security: prevent path traversal
    if (!filePath.startsWith(STUDIO_DIST)) {
      return new Response("Forbidden", { status: 403 });
    }

    return file.exists().then((exists) => {
      if (exists) return new Response(file);
      // SPA fallback: serve index.html for client-side routes
      return new Response(Bun.file(join(STUDIO_DIST, "index.html")));
    });
  });

app.listen(port);

console.log(`[server] listening on http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
