import { afterAll, beforeAll, describe } from "bun:test"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import {
  createServerContext,
  shutdown,
} from "@ellie/durable-streams/server"
import { handleStreamRequest } from "../src/routes/streams"

describe(`Bun.serve Durable Streams Server`, () => {
  let server: ReturnType<typeof Bun.serve>
  let ctx: ReturnType<typeof createServerContext>
  const config = { baseUrl: `` }

  beforeAll(async () => {
    ctx = createServerContext({ longPollTimeout: 500 })

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const response = handleStreamRequest(ctx, req, url.pathname)
        if (response) return response
        return new Response(`Not found`, { status: 404 })
      },
    })

    config.baseUrl = `http://localhost:${server.port}/streams`
  })

  afterAll(async () => {
    shutdown(ctx)
    server.stop(true)
  })

  runConformanceTests(config)
})
