import type { StandardSchemaV1 } from "@standard-schema/spec"
import { createRouter } from "../src/server/router"

/**
 * Minimal fake schema conforming to StandardSchemaV1.
 * Only needs `~standard` property for the router's runtime check.
 */
export function fakeSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: `test`,
      validate: (value: unknown) => ({ value }),
    },
  } as StandardSchemaV1
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

/** Procedure-only router with path params */
export function procedureRouter() {
  return createRouter().post(`recall`, `/banks/:bankId/recall`, {
    input: fakeSchema(),
    output: fakeSchema(),
  })
}

/** Procedure without path params */
export function paramlessProcedureRouter() {
  return createRouter().get(`listBanks`, `/banks`, {
    input: fakeSchema(),
    output: fakeSchema(),
  })
}

/** Mixed router: streams + procedures */
export function mixedRouter() {
  return createRouter()
    .stream(`chat`, `/chat/:chatId`, { messages: fakeSchema() })
    .post(`recall`, `/banks/:bankId/recall`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
    .get(`listBanks`, `/banks`, {
      input: fakeSchema(),
      output: fakeSchema(),
    })
}
