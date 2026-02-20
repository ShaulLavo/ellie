import { describe, it, expect } from "bun:test"
import { runConformanceTests } from "@durable-streams/client-conformance-tests"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

describe(`@ellie/streams-client conformance`, () => {
  it(`passes all client conformance tests`, async () => {
    const adapterPath = resolve(__dirname, `adapter.ts`)

    const summary = await runConformanceTests({
      clientAdapter: `bun`,
      clientArgs: [`run`, adapterPath],
      verbose: false,
      testTimeout: 30000,
    })

    expect(summary.failed).toBe(0)
  }, 120_000)
})
