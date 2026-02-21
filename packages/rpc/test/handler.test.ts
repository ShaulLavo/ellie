import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createRouter } from "../src/server/router"
import { handleProcedureRequest } from "../src/server/handler"
import type { ProcedureHandlers } from "../src/server/handler"
import { fakeSchema } from "./helpers"

// ---------------------------------------------------------------------------
// Test router with procedures
// ---------------------------------------------------------------------------

const testRouter = createRouter()
  .post(`createBank`, `/banks`, { input: fakeSchema(), output: fakeSchema() })
  .get(`listBanks`, `/banks`, { input: fakeSchema(), output: fakeSchema() })
  .get(`getBank`, `/banks/:bankId`, { input: fakeSchema(), output: fakeSchema() })
  .delete(`deleteBank`, `/banks/:bankId`, { input: fakeSchema(), output: fakeSchema() })
  .post(`recall`, `/banks/:bankId/recall`, { input: fakeSchema(), output: fakeSchema() })

type TestRouterDef = typeof testRouter._def

const handlers: ProcedureHandlers<TestRouterDef> = {
  createBank: async (input) => ({ id: `bank-1`, name: (input as any)?.name }),
  listBanks: async () => [{ id: `bank-1`, name: `My Bank` }],
  getBank: async (_input, params) => ({ id: params.bankId, name: `Bank` }),
  deleteBank: async (_input, params) => {
    if (params.bankId === `not-found`) throw new Error(`Bank not found`)
    return undefined
  },
  recall: async (input, params) => ({
    bankId: params.bankId,
    query: (input as any)?.query,
    results: [],
  }),
}

// ---------------------------------------------------------------------------
// In-process Bun server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>
let baseUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const result = handleProcedureRequest(
        testRouter._def,
        req,
        url.pathname,
        handlers
      )
      if (result) return result
      return new Response(`Not Found`, { status: 404 })
    },
  })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`handleProcedureRequest`, () => {
  it(`dispatches POST /banks to createBank`, async () => {
    const res = await fetch(`${baseUrl}/banks`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ name: `Test` }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ id: `bank-1`, name: `Test` })
  })

  it(`dispatches GET /banks to listBanks`, async () => {
    const res = await fetch(`${baseUrl}/banks`)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([{ id: `bank-1`, name: `My Bank` }])
  })

  it(`extracts path params: GET /banks/:bankId`, async () => {
    const res = await fetch(`${baseUrl}/banks/abc-123`)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ id: `abc-123`, name: `Bank` })
  })

  it(`dispatches POST with JSON body: /banks/:bankId/recall`, async () => {
    const res = await fetch(`${baseUrl}/banks/b1/recall`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ query: `hiking` }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ bankId: `b1`, query: `hiking`, results: [] })
  })

  it(`returns 204 when handler returns undefined`, async () => {
    const res = await fetch(`${baseUrl}/banks/b1`, { method: `DELETE` })
    expect(res.status).toBe(204)
  })

  it(`returns 404 when error message contains "not found"`, async () => {
    const res = await fetch(`${baseUrl}/banks/not-found`, { method: `DELETE` })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain(`not found`)
  })

  it(`returns null for unmatched paths`, async () => {
    const res = await fetch(`${baseUrl}/unknown/path`)
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toBe(`Not Found`)
  })

  it(`returns null for wrong HTTP method on matched path`, async () => {
    const res = await fetch(`${baseUrl}/banks`, { method: `PATCH` })
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toBe(`Not Found`)
  })

  it(`decodes URL-encoded path params`, async () => {
    const res = await fetch(`${baseUrl}/banks/${encodeURIComponent(`bank with spaces`)}`)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe(`bank with spaces`)
  })

  it(`parses query params for GET requests`, async () => {
    const res = await fetch(`${baseUrl}/banks/b1?extra=value`)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe(`b1`)
  })
})
