import { Elysia } from "elysia";
import {
  createServerContext,
  setDurableStreamHeaders,
} from "@ellie/durable-streams/server";
import { streamRoutes } from "./routes/streams";

const port = parseInt(Bun.env.PORT ?? `4437`);

const ctx = createServerContext();

const app = new Elysia()
  .onRequest(({ set }) => {
    setDurableStreamHeaders(set.headers as Record<string, string | number>);
  })
  .use(streamRoutes(ctx, true));

app.listen(port);

console.log(`server running at http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
