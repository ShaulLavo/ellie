import { afterAll, beforeAll, describe } from "vitest"
import { runConformanceTests } from "@durable-streams/server-conformance-tests"
import { createDurableStreamServer } from "../src/server"

describe(`Elysia Durable Streams Server`, () => {
  let server: ReturnType<typeof createDurableStreamServer>
  const config = { baseUrl: `` }

  beforeAll(async () => {
    server = createDurableStreamServer({
      port: 0,
      longPollTimeout: 500,
    })

    // Listen on random port
    const instance = server.app.listen(0)
    const port = instance.server?.port
    config.baseUrl = `http://localhost:${port}/streams`
  })

  afterAll(async () => {
    server.ctx.isShuttingDown = true
    server.ctx.store.cancelAllWaits()
    for (const controller of server.ctx.activeSSEResponses) {
      try {
        controller.close()
      } catch {
        // Already closed
      }
    }
    server.ctx.activeSSEResponses.clear()
    server.app.stop()
  })

  runConformanceTests(config)
})
