import { Elysia } from "elysia";
import { createServerContext } from "@ellie/durable-streams/server";
import { DurableStore } from "@ellie/durable-streams";
import { JsonlStore } from "@ellie/db";
import { streamRoutes } from "./routes/streams";

const port = parseInt(Bun.env.PORT ?? `4437`);
const DATA_DIR = Bun.env.DATA_DIR ?? "./data";

const jsonlStore = new JsonlStore(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);
const durableStore = new DurableStore(jsonlStore);
const ctx = createServerContext({ store: durableStore });

const app = new Elysia().use(streamRoutes(ctx));

app.listen(port);

console.log(`server running at http://localhost:${port}`);

export { app, ctx };
export type App = typeof app;
