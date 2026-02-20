import { afterAll, beforeAll, describe } from "bun:test"
import { runConformanceTests } from "./server-conformance-suite"
import {
  createServerContext,
  handleDurableStreamRequest,
  shutdown,
} from "../src/server/index"

describe(`Durable Streams Server Conformance`, () => {
  let server: ReturnType<typeof Bun.serve>
  let ctx: ReturnType<typeof createServerContext>
  const config = { baseUrl: `` }

  beforeAll(async () => {
    ctx = createServerContext({ longPollTimeout: 500 })

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        return handleDurableStreamRequest(ctx, req)
      },
    })

    config.baseUrl = `http://localhost:${server.port}`
  })

  afterAll(async () => {
    shutdown(ctx)
    server.stop(true)
  })

  runConformanceTests(config)
})
