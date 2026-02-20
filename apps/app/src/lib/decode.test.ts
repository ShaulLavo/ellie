import { describe, expect, it } from "bun:test"
import * as v from "valibot"
import { decodeAndValidate } from "./decode"
import type { StreamMessage } from "@ellie/durable-streams"

const encoder = new TextEncoder()

function makeMsg(json: string, commaTerminated = true): StreamMessage {
  const raw = commaTerminated ? `${json},` : json
  return {
    data: encoder.encode(raw),
    offset: `0000000000000000_0000000000000001`,
    timestamp: Date.now(),
  }
}

describe(`decodeAndValidate`, () => {
  // looseObject allows and preserves additional properties (like TypeBox default)
  const schema = v.looseObject({
    role: v.string(),
    content: v.string(),
  })

  it(`parses and validates a valid comma-terminated message`, () => {
    const msg = makeMsg(`{"role":"user","content":"hello"}`)
    const result = decodeAndValidate(msg, schema)
    expect(result).toEqual({ role: `user`, content: `hello` })
  })

  it(`parses a message without trailing comma`, () => {
    const msg = makeMsg(`{"role":"user","content":"hello"}`, false)
    const result = decodeAndValidate(msg, schema)
    expect(result).toEqual({ role: `user`, content: `hello` })
  })

  it(`strips trailing whitespace before comma`, () => {
    const msg: StreamMessage = {
      data: encoder.encode(`{"role":"user","content":"hi"} ,`),
      offset: `0000000000000000_0000000000000001`,
      timestamp: Date.now(),
    }
    const result = decodeAndValidate(msg, schema)
    expect(result).toEqual({ role: `user`, content: `hi` })
  })

  it(`throws on invalid JSON`, () => {
    const msg = makeMsg(`{not valid json}`)
    expect(() => decodeAndValidate(msg, schema)).toThrow()
  })

  it(`throws when message violates schema — missing field`, () => {
    const msg = makeMsg(`{"role":"user"}`)
    expect(() => decodeAndValidate(msg, schema)).toThrow(
      /schema validation/
    )
  })

  it(`throws when message violates schema — wrong type`, () => {
    const msg = makeMsg(`{"role":"user","content":42}`)
    expect(() => decodeAndValidate(msg, schema)).toThrow(
      /schema validation/
    )
  })

  it(`allows extra properties with looseObject`, () => {
    const msg = makeMsg(`{"role":"user","content":"hi","extra":"field"}`)
    // looseObject allows additional properties (preserves them in output)
    const result = decodeAndValidate(msg, schema)
    expect(result).toEqual({ role: `user`, content: `hi`, extra: `field` })
  })

  it(`rejects extra properties with strictObject`, () => {
    const strict = v.strictObject({
      role: v.string(),
      content: v.string(),
    })

    const msg = makeMsg(`{"role":"user","content":"hi","extra":"field"}`)
    expect(() => decodeAndValidate(msg, strict)).toThrow(
      /schema validation/
    )
  })

  it(`validates a number schema`, () => {
    const numSchema = v.number()
    const msg = makeMsg(`42`)
    expect(decodeAndValidate(msg, numSchema)).toBe(42)
  })

  it(`rejects wrong type for number schema`, () => {
    const numSchema = v.number()
    const msg = makeMsg(`"not a number"`)
    expect(() => decodeAndValidate(msg, numSchema)).toThrow(
      /schema validation/
    )
  })
})
