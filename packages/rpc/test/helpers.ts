import type { StandardSchemaV1 } from "@standard-schema/spec"
import { createRouter } from "../src/server/router"

/**
 * Minimal fake schema conforming to StandardSchemaV1.
 * Only needs `~standard` property for the router's runtime check.
 */
export function fakeSchema(): StandardSchemaV1<any> {
  return {
    "~standard": {
      version: 1,
      vendor: `test`,
      validate: (value: unknown) => ({ value }),
    },
  } as StandardSchemaV1<any>
}

/** Single-stream router: chat with messages collection */
export function chatRouter() {
  return createRouter().stream(`chat`, `/chat/:chatId`, {
    messages: fakeSchema(),
  })
}

/** Multi-stream router: chat + settings */
export function multiStreamRouter() {
  return createRouter()
    .stream(`chat`, `/chat/:chatId`, { messages: fakeSchema() })
    .stream(`settings`, `/settings`, { prefs: fakeSchema() })
}

/** Router with multiple collections in one stream */
export function multiCollectionRouter() {
  return createRouter().stream(`chat`, `/chat/:chatId`, {
    messages: {
      schema: fakeSchema(),
      type: `messages`,
      primaryKey: `id`,
    },
    reactions: {
      schema: fakeSchema(),
      type: `reactions`,
      primaryKey: `id`,
    },
  })
}
