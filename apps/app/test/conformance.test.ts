import { Elysia } from "elysia"
import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import {
  createServerContext,
  shutdown,
  setDurableStreamHeaders,
} from "@ellie/durable-streams/server"
import { streamRoutes } from "../src/routes/streams"

describe(`Elysia Durable Streams Server`, () => {
  let app: { listen: (port: number) => { server?: { port?: number } | null }; stop: () => void }
  let ctx: ReturnType<typeof createServerContext>
  const config = { baseUrl: `` }

  beforeAll(async () => {
    ctx = createServerContext({ longPollTimeout: 500 })

    app = new Elysia()
      .onRequest(({ set }) => {
        setDurableStreamHeaders(set.headers as Record<string, string>)
      })
      .use(streamRoutes(ctx))

    const instance = app.listen(0)
    const port = instance.server?.port
    config.baseUrl = `http://localhost:${port}/streams`
  })

  afterAll(async () => {
    shutdown(ctx)
    app.stop()
  })

  runConformanceTests(config)
})
