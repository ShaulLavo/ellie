import { Elysia } from "elysia";
import { createServerContext } from "@ellie/durable-streams/server";
import { streamRoutes } from "./routes/streams";

const port = parseInt(Bun.env.PORT ?? `4437`);

const ctx = createServerContext();

const app = new Elysia().use(streamRoutes(ctx));

app.listen(port);

console.log(`server running at http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
