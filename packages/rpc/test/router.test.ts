import { describe, expect, it } from "bun:test"
import { createRouter } from "../src/server/router"
import { fakeSchema, mixedRouter } from "./helpers"

describe(`createRouter`, () => {
  it(`returns a router with empty _def`, () => {
    const router = createRouter()
    expect(router._def).toEqual({})
  })

  it(`.stream() adds a stream definition to _def`, () => {
    const schema = fakeSchema()
    const router = createRouter().stream(`chat`, `/chat/:chatId`, {
      messages: schema,
    })

    expect(router._def.chat).toBeDefined()
    expect(router._def.chat.path).toBe(`/chat/:chatId`)
    expect(router._def.chat.collections.messages).toBeDefined()
    expect(router._def.chat.collections.messages.schema).toBe(schema)
  })

  it(`normalizes bare schemas to CollectionDef with defaults`, () => {
    const schema = fakeSchema()
    const router = createRouter().stream(`chat`, `/chat/:chatId`, {
      messages: schema,
    })

    const col = router._def.chat.collections.messages
    expect(col.schema).toBe(schema)
    expect(col.type).toBe(`messages`)
    expect(col.primaryKey).toBe(`id`)
  })

  it(`respects { schema, type, primaryKey } config objects`, () => {
    const schema = fakeSchema()
    const router = createRouter().stream(`chat`, `/chat/:chatId`, {
      messages: {
        schema,
        type: `msg`,
        primaryKey: `msgId`,
      },
    })

    const col = router._def.chat.collections.messages
    expect(col.schema).toBe(schema)
    expect(col.type).toBe(`msg`)
    expect(col.primaryKey).toBe(`msgId`)
  })

  it(`is chainable for multiple streams`, () => {
    const router = createRouter()
      .stream(`chat`, `/chat/:chatId`, { messages: fakeSchema() })
      .stream(`settings`, `/settings`, { prefs: fakeSchema() })

    expect(router._def.chat).toBeDefined()
    expect(router._def.settings).toBeDefined()
    expect(router._def.chat.path).toBe(`/chat/:chatId`)
    expect(router._def.settings.path).toBe(`/settings`)
  })

  it(`returns a new builder on each .stream() call (immutable)`, () => {
    const first = createRouter().stream(`chat`, `/chat/:chatId`, {
      messages: fakeSchema(),
    })
    const second = first.stream(`settings`, `/settings`, {
      prefs: fakeSchema(),
    })

    expect(first._def).not.toHaveProperty(`settings`)
    expect(second._def).toHaveProperty(`settings`)
    expect(second._def).toHaveProperty(`chat`)
  })

  it(`throws on duplicate stream name`, () => {
    expect(() =>
      createRouter()
        .stream(`chat`, `/chat/:chatId`, { messages: fakeSchema() })
        .stream(`chat`, `/chat/:otherId`, { items: fakeSchema() })
    ).toThrow(`Duplicate name`)
  })

  it(`throws when path uses reserved param :value`, () => {
    expect(() =>
      createRouter().stream(`items`, `/items/:value`, {
        entries: fakeSchema(),
      })
    ).toThrow(`reserved param`)
  })

  it(`throws when path uses reserved param :key`, () => {
    expect(() =>
      createRouter().stream(`items`, `/items/:key`, {
        entries: fakeSchema(),
      })
    ).toThrow(`reserved param`)
  })

  it(`throws on duplicate event types within a stream`, () => {
    expect(() =>
      createRouter().stream(`chat`, `/chat/:chatId`, {
        messages: { schema: fakeSchema(), type: `msg` },
        reactions: { schema: fakeSchema(), type: `msg` },
      })
    ).toThrow(`Duplicate event type`)
  })

  it(`allows same collection name across different streams`, () => {
    expect(() =>
      createRouter()
        .stream(`a`, `/a`, { items: fakeSchema() })
        .stream(`b`, `/b`, { items: fakeSchema() })
    ).not.toThrow()
  })
})

describe(`createRouter verb methods`, () => {
  it(`.post() adds a procedure definition to _def`, () => {
    const input = fakeSchema()
    const output = fakeSchema()
    const router = createRouter().post(`recall`, `/banks/:bankId/recall`, {
      input,
      output,
    })

    expect(router._def.recall).toBeDefined()
    expect(router._def.recall.path).toBe(`/banks/:bankId/recall`)
    expect(router._def.recall.input).toBe(input)
    expect(router._def.recall.output).toBe(output)
    expect(router._def.recall.method).toBe(`POST`)
  })

  it(`.get() sets method to GET`, () => {
    const router = createRouter().get(`listBanks`, `/banks`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
    expect(router._def.listBanks.method).toBe(`GET`)
  })

  it(`.patch() sets method to PATCH`, () => {
    const router = createRouter().patch(`updateBank`, `/banks/:bankId`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
    expect(router._def.updateBank.method).toBe(`PATCH`)
  })

  it(`.delete() sets method to DELETE`, () => {
    const router = createRouter().delete(`deleteBank`, `/banks/:bankId`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
    expect(router._def.deleteBank.method).toBe(`DELETE`)
  })

  it(`throws on duplicate name`, () => {
    expect(() =>
      createRouter()
        .post(`recall`, `/recall`, { input: fakeSchema(), output: fakeSchema() })
        .post(`recall`, `/other`, { input: fakeSchema(), output: fakeSchema() })
    ).toThrow(`Duplicate name`)
  })

  it(`throws on duplicate name across stream and procedure`, () => {
    expect(() =>
      createRouter()
        .stream(`chat`, `/chat/:chatId`, { messages: fakeSchema() })
        .post(`chat`, `/chat/action`, { input: fakeSchema(), output: fakeSchema() })
    ).toThrow(`Duplicate name`)
  })

  it(`throws when path uses reserved param :input`, () => {
    expect(() =>
      createRouter().post(`bad`, `/items/:input`, {
        input: fakeSchema(),
        output: fakeSchema(),
      })
    ).toThrow(`reserved param`)
  })

  it(`is chainable with .stream()`, () => {
    const router = mixedRouter()
    expect(router._def.chat).toBeDefined()
    expect(router._def.recall).toBeDefined()
    expect(router._def.listBanks).toBeDefined()
    expect(`collections` in router._def.chat).toBe(true)
    expect(`collections` in router._def.recall).toBe(false)
  })

  it(`returns a new builder on each verb call (immutable)`, () => {
    const first = createRouter().post(`a`, `/a`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
    const second = first.post(`b`, `/b`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })

    expect(first._def).not.toHaveProperty(`b`)
    expect(second._def).toHaveProperty(`a`)
    expect(second._def).toHaveProperty(`b`)
  })
})
