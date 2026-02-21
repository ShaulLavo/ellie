import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import {
  createServerContext,
  handleDurableStreamRequest,
  shutdown,
} from "@ellie/durable-streams/server"
import { createRouter } from "../src/server/router"
import { StreamManager } from "../src/client/manager"
import { fakeSchema } from "./helpers"

// ---------------------------------------------------------------------------
// Real durable-streams server (in-process, ephemeral)
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>
let ctx: ReturnType<typeof createServerContext>
let baseUrl: string

beforeAll(() => {
  ctx = createServerContext({ longPollTimeout: 500 })
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      return handleDurableStreamRequest(ctx, req)
    },
  })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  shutdown(ctx)
  server.stop(true)
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const schema = fakeSchema()

const chatStreamDef = createRouter()
  .stream(`chat`, `/chat/:chatId`, { messages: schema })
  ._def.chat

const settingsStreamDef = createRouter()
  .stream(`settings`, `/settings`, { prefs: schema })
  ._def.settings

function makeMessage(id: string, content: string) {
  return { id, content }
}

// Use a unique chatId per test to avoid cross-test interference
let testCounter = 0
function uniqueParams() {
  return { chatId: `test-${++testCounter}-${Date.now()}` }
}

/**
 * Poll manager.get() until predicate passes.
 * The consumer's long-poll needs time to receive appended events.
 */
async function waitFor(
  manager: StreamManager,
  streamDef: any,
  collection: string,
  params: Record<string, string>,
  predicate: (items: unknown[]) => boolean,
  timeoutMs = 2000
) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const items = await manager.get(streamDef, collection, params)
    if (predicate(items)) return items
    await new Promise((r) => setTimeout(r, 50))
  }
  // Final attempt — let it throw the normal expect failure
  return manager.get(streamDef, collection, params)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`StreamManager`, () => {
  let manager: StreamManager

  beforeEach(() => {
    manager = new StreamManager(baseUrl)
  })

  describe(`get`, () => {
    it(`returns empty array for a fresh stream`, async () => {
      const result = await manager.get(chatStreamDef, `messages`, uniqueParams())
      expect(result).toEqual([])
    })

    it(`throws on unknown collection name`, async () => {
      await expect(
        manager.get(chatStreamDef, `nonexistent`, uniqueParams())
      ).rejects.toThrow(`Collection "nonexistent" not found`)
    })
  })

  describe(`mutate + get (round-trip)`, () => {
    it(`insert then get returns the inserted item`, async () => {
      const params = uniqueParams()
      const msg = makeMessage(`m1`, `hello`)

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg,
      })
      const result = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      expect(result).toEqual([msg])
    })

    it(`multiple inserts accumulate`, async () => {
      const params = uniqueParams()
      const msg1 = makeMessage(`m1`, `first`)
      const msg2 = makeMessage(`m2`, `second`)

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg1,
      })
      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg2,
      })
      const result = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 2
      )

      expect(result).toContainEqual(msg1)
      expect(result).toContainEqual(msg2)
    })

    it(`update modifies an existing item`, async () => {
      const params = uniqueParams()
      const original = makeMessage(`m1`, `original`)
      const updated = makeMessage(`m1`, `updated`)

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: original,
      })
      await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      await manager.mutate(chatStreamDef, `messages`, `update`, params, {
        value: updated,
      })
      const result = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1 && (items[0] as any).content === `updated`
      )

      expect(result).toEqual([updated])
    })

    it(`delete removes an item by key`, async () => {
      const params = uniqueParams()
      const msg = makeMessage(`m1`, `to-delete`)

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg,
      })
      await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      await manager.mutate(chatStreamDef, `messages`, `delete`, params, {
        key: `m1`,
      })
      const result = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 0
      )

      expect(result).toEqual([])
    })

    it(`upsert inserts if not present, updates if present`, async () => {
      const params = uniqueParams()
      const v1 = makeMessage(`m1`, `v1`)
      const v2 = makeMessage(`m1`, `v2`)

      await manager.mutate(chatStreamDef, `messages`, `upsert`, params, {
        value: v1,
      })
      const afterInsert = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )
      expect(afterInsert).toEqual([v1])

      await manager.mutate(chatStreamDef, `messages`, `upsert`, params, {
        value: v2,
      })
      const afterUpdate = await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1 && (items[0] as any).content === `v2`
      )
      expect(afterUpdate).toEqual([v2])
    })
  })

  describe(`subscribe`, () => {
    it(`returns a handle with collection and ready promise`, async () => {
      const handle = manager.subscribe(
        chatStreamDef,
        `messages`,
        uniqueParams()
      )

      expect(handle).toHaveProperty(`collection`)
      expect(handle).toHaveProperty(`ready`)
      expect(handle).toHaveProperty(`unsubscribe`)
      expect(typeof handle.unsubscribe).toBe(`function`)

      await handle.ready
      handle.unsubscribe()
    })

    it(`throws on unknown collection name`, () => {
      expect(() =>
        manager.subscribe(chatStreamDef, `nonexistent`, uniqueParams())
      ).toThrow(`Collection "nonexistent" not found`)
    })
  })

  describe(`clearStream`, () => {
    it(`clears all data and allows fresh writes`, async () => {
      const params = uniqueParams()
      const msg = makeMessage(`m1`, `before-clear`)

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg,
      })
      await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      await manager.clearStream(chatStreamDef, params)

      // Fresh manager — old cache is stale after clear
      const freshManager = new StreamManager(baseUrl)
      const result = await freshManager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])

      // Can write again after clear
      const newMsg = makeMessage(`m2`, `after-clear`)
      await freshManager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: newMsg,
      })
      const result2 = await waitFor(
        freshManager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )
      expect(result2).toEqual([newMsg])
    })
  })

  describe(`deleteStream`, () => {
    it(`deletes the stream`, async () => {
      const params = uniqueParams()
      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: makeMessage(`m1`, `to-delete`),
      })
      await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      await manager.deleteStream(chatStreamDef, params)

      // Fresh manager — stream was deleted, get auto-creates a new empty one
      const freshManager = new StreamManager(baseUrl)
      const result = await freshManager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])
    })

    it(`does not throw when deleting a non-cached stream`, async () => {
      const freshManager = new StreamManager(baseUrl)
      await expect(
        freshManager.deleteStream(chatStreamDef, uniqueParams())
      ).resolves.toBeUndefined()
    })
  })

  describe(`parameterless streams`, () => {
    it(`works with streams that have no path params`, async () => {
      const pref = { id: `theme`, content: `dark` }

      await manager.mutate(settingsStreamDef, `prefs`, `insert`, {}, {
        value: pref,
      })
      const result = await waitFor(
        manager, settingsStreamDef, `prefs`, {},
        (items) => items.length === 1
      )

      expect(result).toEqual([pref])
    })
  })

  describe(`path resolution errors`, () => {
    it(`throws when required path params are missing`, () => {
      expect(() =>
        manager.get(chatStreamDef, `messages`, {})
      ).toThrow(`Missing params`)
    })
  })

  describe(`caching`, () => {
    it(`reuses the same StreamDB for the same resolved path`, async () => {
      const params = uniqueParams()

      // Two get calls with the same params should share the StreamDB
      const r1 = await manager.get(chatStreamDef, `messages`, params)
      const r2 = await manager.get(chatStreamDef, `messages`, params)
      expect(r1).toEqual(r2)
    })

    it(`different params create separate StreamDB instances`, async () => {
      const params1 = uniqueParams()
      const params2 = uniqueParams()

      await manager.mutate(chatStreamDef, `messages`, `insert`, params1, {
        value: makeMessage(`m1`, `stream-1`),
      })
      const r1 = await waitFor(
        manager, chatStreamDef, `messages`, params1,
        (items) => items.length === 1
      )
      const r2 = await manager.get(chatStreamDef, `messages`, params2)

      expect(r1).toHaveLength(1)
      expect(r2).toEqual([])
    })
  })

  describe(`ref counting edge cases`, () => {
    it(`subscribe with bad collection leaks a ref`, async () => {
      const params = uniqueParams()

      // subscribe() increments refs before checking the collection name.
      // If the collection is not found, it throws — but refs is already +1.
      expect(() =>
        manager.subscribe(chatStreamDef, `nonexistent`, params)
      ).toThrow(`Collection "nonexistent" not found`)

      // The cache entry exists with refs=1 (leaked). A valid subscribe
      // reuses the entry and bumps refs to 2.
      const handle = manager.subscribe(chatStreamDef, `messages`, params)
      await handle.ready

      // One unsubscribe brings refs to 1 — cleanup should NOT happen
      // because the leaked ref is still counted.
      handle.unsubscribe()

      // Stream is still accessible (cache entry not evicted)
      const result = await manager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])
    })

    it(`cleanup only on last unsubscribe`, async () => {
      const params = uniqueParams()

      const handle1 = manager.subscribe(chatStreamDef, `messages`, params)
      await handle1.ready
      // refs = 1

      const handle2 = manager.subscribe(chatStreamDef, `messages`, params)
      // refs = 2

      handle1.unsubscribe()
      // refs = 1 — no cleanup

      // Stream still accessible
      const result = await manager.get(chatStreamDef, `messages`, params)
      expect(Array.isArray(result)).toBe(true)

      handle2.unsubscribe()
      // refs = 0 — cleanup triggers

      // Next get() creates a fresh entry
      const result2 = await manager.get(chatStreamDef, `messages`, params)
      expect(result2).toEqual([])
    })

    it(`delete while subscribed evicts immediately`, async () => {
      const params = uniqueParams()
      const msg = makeMessage(`m1`, `before-delete`)

      const handle = manager.subscribe(chatStreamDef, `messages`, params)
      await handle.ready

      await manager.mutate(chatStreamDef, `messages`, `insert`, params, {
        value: msg,
      })
      await waitFor(
        manager, chatStreamDef, `messages`, params,
        (items) => items.length === 1
      )

      // deleteStream closes and evicts immediately, regardless of refs
      await manager.deleteStream(chatStreamDef, params)

      // Old handle's unsubscribe is safe even after eviction
      expect(() => handle.unsubscribe()).not.toThrow()

      // Re-subscribe creates a fresh entry (auto-creates empty stream)
      const freshHandle = manager.subscribe(chatStreamDef, `messages`, params)
      await freshHandle.ready

      const result = await manager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])

      freshHandle.unsubscribe()
    })
  })

  describe(`unsubscribe after ready settles`, () => {
    it(`cleanup happens after ready resolves and all refs released`, async () => {
      const params = uniqueParams()

      const handle = manager.subscribe(chatStreamDef, `messages`, params)
      await handle.ready
      // settled = true after ready resolves

      handle.unsubscribe()
      // refs = 0 + settled = true → synchronous cleanup (line 190)

      // Cache entry was evicted — next get creates a fresh one
      const result = await manager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])
    })

    it(`cleanup waits for ready when not yet settled`, async () => {
      const params = uniqueParams()

      // subscribe returns synchronously; ready is pending
      const handle = manager.subscribe(chatStreamDef, `messages`, params)

      // Unsubscribe immediately — ready hasn't settled yet, so cleanup
      // defers via entry.ready.then(cleanup, cleanup)
      handle.unsubscribe()

      // Wait for ready to settle (it should resolve successfully)
      await handle.ready

      // After ready settles, the deferred cleanup should have run.
      // Next get creates a fresh entry.
      const result = await manager.get(chatStreamDef, `messages`, params)
      expect(result).toEqual([])
    })
  })
})
