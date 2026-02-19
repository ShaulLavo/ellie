import { Elysia } from "elysia";
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

const app = new Elysia()
  // TODO: Delete this onAfterResponse hook — it constructs new URL(request.url) on every
  // response just for logging, and infers "polling" from HTTP status codes. Logging shouldn't
  // be on the hot path. May not be relevant anymore.
  .onAfterResponse(({ request, response }) => {
    const url = new URL(request.url);
    const status = response instanceof Response ? response.status : response;
    const method = request.method;

    // Label polling vs real requests
    const isPolling =
      (method === "GET" && status === 304) ||
      (method === "PUT" && status === 200);
    const tag = isPolling ? "[poll]" : "[server]";

    console.log(`${tag} ${method} ${url.pathname} ${status}`);
  })
  .use(streamRoutes(ctx));

app.listen(port);

console.log(`[server] listening on http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
