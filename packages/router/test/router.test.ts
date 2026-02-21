import { describe, it, expect } from "bun:test"
import * as v from "valibot"
import { appRouter, messageSchema } from "../src/index"

describe("appRouter", () => {
  it("has a chat stream definition", () => {
    expect(appRouter._def).toHaveProperty("chat")
    expect(appRouter._def.chat).toBeDefined()
  })

  it("chat stream has path /chat/:chatId", () => {
    expect(appRouter._def.chat.path).toBe("/chat/:chatId")
  })

  it("chat stream has a messages collection with schema", () => {
    expect(appRouter._def.chat.collections).toHaveProperty("messages")
    expect(appRouter._def.chat.collections.messages).toBeDefined()
    expect(appRouter._def.chat.collections.messages.schema).toBeDefined()
  })
})

describe("messageSchema", () => {
  it("validates a correct message", () => {
    const valid = {
      id: "msg-1",
      role: "user" as const,
      content: "Hello!",
      createdAt: "2025-01-01T00:00:00Z",
    }
    const result = v.safeParse(messageSchema, valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output).toEqual(valid)
    }
  })

  it("validates all three roles", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const msg = { id: "1", role, content: "test", createdAt: "2025-01-01" }
      expect(v.safeParse(messageSchema, msg).success).toBe(true)
    }
  })

  it("rejects an invalid role", () => {
    const invalid = {
      id: "msg-1",
      role: "moderator",
      content: "Hello!",
      createdAt: "2025-01-01T00:00:00Z",
    }
    expect(v.safeParse(messageSchema, invalid).success).toBe(false)
  })

  it("rejects missing id", () => {
    const msg = { role: "user", content: "Hello!", createdAt: "2025-01-01" }
    expect(v.safeParse(messageSchema, msg).success).toBe(false)
  })

  it("rejects missing content", () => {
    const msg = { id: "1", role: "user", createdAt: "2025-01-01" }
    expect(v.safeParse(messageSchema, msg).success).toBe(false)
  })

  it("rejects missing role", () => {
    const msg = { id: "1", content: "Hello!", createdAt: "2025-01-01" }
    expect(v.safeParse(messageSchema, msg).success).toBe(false)
  })

  it("rejects missing createdAt", () => {
    const msg = { id: "1", role: "user", content: "Hello!" }
    expect(v.safeParse(messageSchema, msg).success).toBe(false)
  })

  it("rejects non-string id", () => {
    const msg = { id: 123, role: "user", content: "Hello!", createdAt: "2025-01-01" }
    expect(v.safeParse(messageSchema, msg).success).toBe(false)
  })

  it("conforms to StandardSchemaV1", () => {
    const schema = messageSchema as unknown as Record<string, Record<string, unknown>>
    expect(schema).toHaveProperty("~standard")
    expect(schema["~standard"].version).toBe(1)
    expect(schema["~standard"]).toHaveProperty("vendor")
    expect(typeof schema["~standard"].validate).toBe("function")
  })
})
