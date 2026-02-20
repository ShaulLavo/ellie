import { describe, expect, it } from "bun:test"
import { createRouter } from "../src/server/router"
import { fakeSchema } from "./helpers"

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
    ).toThrow(`Duplicate stream name`)
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
