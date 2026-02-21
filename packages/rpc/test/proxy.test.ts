import { describe, expect, it, mock, beforeEach } from "bun:test"
import { fakeSchema, chatRouter, procedureRouter, mixedRouter } from "./helpers"
import { createRouter } from "../src/server/router"

// ---------------------------------------------------------------------------
// Mock StreamManager
// ---------------------------------------------------------------------------

const mockGet = mock(() => Promise.resolve([]))
const mockSubscribe = mock(() => ({
  collection: {},
  ready: Promise.resolve(),
  unsubscribe: mock(),
}))
const mockMutate = mock(() => Promise.resolve())
const mockClearStream = mock(() => Promise.resolve())
const mockDeleteStream = mock(() => Promise.resolve())
const mockCall = mock(() => Promise.resolve({ result: `ok` }))

mock.module(`../src/client/manager`, () => ({
  StreamManager: class MockStreamManager {
    constructor(public baseUrl: string) {}
    get = mockGet
    subscribe = mockSubscribe
    mutate = mockMutate
    clearStream = mockClearStream
    deleteStream = mockDeleteStream
    call = mockCall
  },
}))

// Import AFTER mock is established
const { createRpcClient } = await import(`../src/client/proxy`)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGet.mockClear()
  mockSubscribe.mockClear()
  mockMutate.mockClear()
  mockClearStream.mockClear()
  mockDeleteStream.mockClear()
  mockCall.mockClear()
})

describe(`createRpcClient`, () => {
  it(`accepts a Router object (with _def)`, () => {
    const router = chatRouter()
    expect(() => createRpcClient(router, { baseUrl: `http://localhost` })).not.toThrow()
  })

  it(`accepts a plain RouterDef (without _def)`, () => {
    const router = chatRouter()
    expect(() => createRpcClient(router._def, { baseUrl: `http://localhost` })).not.toThrow()
  })
})

describe(`proxy method routing`, () => {
  it(`.get() calls manager.get with correct args`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.chat.messages.get({ chatId: `abc` })

    expect(mockGet).toHaveBeenCalledTimes(1)
    const [streamDef, colName, params] = mockGet.mock.calls[0]!
    expect(streamDef.path).toBe(`/chat/:chatId`)
    expect(colName).toBe(`messages`)
    expect(params).toEqual({ chatId: `abc` })
  })

  it(`.subscribe() calls manager.subscribe with correct args`, () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    rpc.chat.messages.subscribe({ chatId: `abc` })

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    const [streamDef, colName, params] = mockSubscribe.mock.calls[0]!
    expect(streamDef.path).toBe(`/chat/:chatId`)
    expect(colName).toBe(`messages`)
    expect(params).toEqual({ chatId: `abc` })
  })

  it(`.insert() separates value from path params`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })
    const value = { id: `1`, content: `hello` }

    await rpc.chat.messages.insert({ chatId: `abc`, value })

    expect(mockMutate).toHaveBeenCalledTimes(1)
    const [streamDef, colName, op, params, payload] = mockMutate.mock.calls[0]!
    expect(streamDef.path).toBe(`/chat/:chatId`)
    expect(colName).toBe(`messages`)
    expect(op).toBe(`insert`)
    expect(params).toEqual({ chatId: `abc` })
    expect(payload).toEqual({ value })
  })

  it(`.update() separates value from path params`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })
    const value = { id: `1`, content: `updated` }

    await rpc.chat.messages.update({ chatId: `abc`, value })

    expect(mockMutate).toHaveBeenCalledTimes(1)
    const [, , op, params, payload] = mockMutate.mock.calls[0]!
    expect(op).toBe(`update`)
    expect(params).toEqual({ chatId: `abc` })
    expect(payload).toEqual({ value })
  })

  it(`.delete() separates key from path params`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.chat.messages.delete({ chatId: `abc`, key: `msg-1` })

    expect(mockMutate).toHaveBeenCalledTimes(1)
    const [, , op, params, payload] = mockMutate.mock.calls[0]!
    expect(op).toBe(`delete`)
    expect(params).toEqual({ chatId: `abc` })
    expect(payload).toEqual({ key: `msg-1` })
  })

  it(`.upsert() separates value from path params`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })
    const value = { id: `1`, content: `upserted` }

    await rpc.chat.messages.upsert({ chatId: `abc`, value })

    expect(mockMutate).toHaveBeenCalledTimes(1)
    const [, , op, params, payload] = mockMutate.mock.calls[0]!
    expect(op).toBe(`upsert`)
    expect(params).toEqual({ chatId: `abc` })
    expect(payload).toEqual({ value })
  })

  it(`collection .clear() calls manager.clearStream`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.chat.messages.clear({ chatId: `abc` })

    expect(mockClearStream).toHaveBeenCalledTimes(1)
    const [streamDef, params] = mockClearStream.mock.calls[0]!
    expect(streamDef.path).toBe(`/chat/:chatId`)
    expect(params).toEqual({ chatId: `abc` })
  })

  it(`stream-level .clear() calls manager.clearStream`, async () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.chat.clear({ chatId: `abc` })

    expect(mockClearStream).toHaveBeenCalledTimes(1)
    const [streamDef, params] = mockClearStream.mock.calls[0]!
    expect(streamDef.path).toBe(`/chat/:chatId`)
    expect(params).toEqual({ chatId: `abc` })
  })

  it(`parameterless paths work with no args`, async () => {
    const router = createRouter().stream(`settings`, `/settings`, {
      prefs: fakeSchema(),
    })
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.settings.prefs.get()

    expect(mockGet).toHaveBeenCalledTimes(1)
    const [, colName, params] = mockGet.mock.calls[0]!
    expect(colName).toBe(`prefs`)
    expect(params).toEqual({})
  })
})

describe(`proxy error handling`, () => {
  it(`throws on unknown stream name`, () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(() => rpc.nonexistent).toThrow(`Unknown name`)
  })

  it(`throws on unknown collection name`, () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(() => rpc.chat.nonexistent).toThrow(`Unknown collection`)
  })
})

describe(`introspection safety`, () => {
  it(`introspection keys return undefined without throwing`, () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(rpc.then).toBeUndefined()
    expect(rpc.toJSON).toBeUndefined()
    expect(rpc.$$typeof).toBeUndefined()
    expect(rpc.valueOf).toBeUndefined()
    expect(rpc.toString).toBeUndefined()
  })

  it(`symbol keys return undefined without throwing`, () => {
    const router = chatRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(rpc[Symbol.toPrimitive]).toBeUndefined()
    expect(rpc[Symbol.iterator]).toBeUndefined()
  })
})

describe(`procedure proxy`, () => {
  it(`procedure returns a callable function`, () => {
    const router = procedureRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(typeof rpc.recall).toBe(`function`)
  })

  it(`calling a procedure invokes manager.call with correct args`, async () => {
    const router = procedureRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    await rpc.recall({ bankId: `b1`, input: { query: `hiking` } })

    expect(mockCall).toHaveBeenCalledTimes(1)
    const [procDef, args] = mockCall.mock.calls[0]!
    expect(procDef.path).toBe(`/banks/:bankId/recall`)
    expect(procDef.method).toBe(`POST`)
    expect(args).toEqual({ bankId: `b1`, input: { query: `hiking` } })
  })

  it(`mixed router: stream access still works alongside procedures`, async () => {
    const router = mixedRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    // Procedure is callable
    expect(typeof rpc.recall).toBe(`function`)
    expect(typeof rpc.listBanks).toBe(`function`)

    // Stream still returns nested proxy
    await rpc.chat.messages.get({ chatId: `abc` })
    expect(mockGet).toHaveBeenCalledTimes(1)

    // Procedure call works
    await rpc.recall({ bankId: `b1`, input: { query: `test` } })
    expect(mockCall).toHaveBeenCalledTimes(1)
  })

  it(`introspection keys return undefined for procedure proxy`, () => {
    const router = procedureRouter()
    const rpc = createRpcClient(router, { baseUrl: `http://localhost` })

    expect(rpc.then).toBeUndefined()
    expect(rpc[Symbol.toPrimitive]).toBeUndefined()
  })
})
