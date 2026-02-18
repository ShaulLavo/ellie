import { describe, expect, it } from "bun:test"
import { StreamStore } from "./store"

function makeOffset(readSeq: number, byteOffset: number): string {
  return `${String(readSeq).padStart(16, "0")}_${String(byteOffset).padStart(16, "0")}`
}

describe("findOffsetIndex (via read)", () => {
  function createStreamWithMessages(count: number) {
    const store = new StreamStore()
    store.create("/test", { contentType: "application/octet-stream" })

    for (let i = 0; i < count; i++) {
      const data = new TextEncoder().encode(`msg-${i}`)
      store.append("/test", data, {})
    }

    return store
  }

  it("returns all messages when offset is before all messages", () => {
    const store = createStreamWithMessages(5)
    const { messages } = store.read("/test", makeOffset(0, 0))
    expect(messages.length).toBe(5)
  })

  it("returns no messages when offset is at or past the last message", () => {
    const store = createStreamWithMessages(3)
    const { messages: all } = store.read("/test")
    const lastOffset = all[all.length - 1]!.offset
    const { messages } = store.read("/test", lastOffset)
    expect(messages.length).toBe(0)
  })

  it("returns messages after the given offset", () => {
    const store = createStreamWithMessages(5)
    const { messages: all } = store.read("/test")
    // Read from second message's offset — should get messages 3, 4, 5
    const { messages } = store.read("/test", all[1]!.offset)
    expect(messages.length).toBe(3)
    expect(messages[0]!.offset).toBe(all[2]!.offset)
  })

  it("returns last message when offset is second-to-last", () => {
    const store = createStreamWithMessages(3)
    const { messages: all } = store.read("/test")
    const { messages } = store.read("/test", all[1]!.offset)
    expect(messages.length).toBe(1)
    expect(messages[0]!.offset).toBe(all[2]!.offset)
  })

  it("works with a single message stream", () => {
    const store = createStreamWithMessages(1)
    const { messages: all } = store.read("/test")

    // Offset before the message
    const { messages: after } = store.read("/test", makeOffset(0, 0))
    expect(after.length).toBe(1)

    // Offset at the message
    const { messages: atEnd } = store.read("/test", all[0]!.offset)
    expect(atEnd.length).toBe(0)
  })

  it("handles offset=-1 by returning all messages", () => {
    const store = createStreamWithMessages(3)
    const { messages } = store.read("/test", "-1")
    expect(messages.length).toBe(3)
  })

  it("works with many messages", () => {
    const store = createStreamWithMessages(100)
    const { messages: all } = store.read("/test")

    // Read from the 50th message offset — should get messages 51-100
    const { messages } = store.read("/test", all[49]!.offset)
    expect(messages.length).toBe(50)
    expect(messages[0]!.offset).toBe(all[50]!.offset)
  })

  it("returns all messages when no offset is provided", () => {
    const store = createStreamWithMessages(5)
    const { messages } = store.read("/test")
    expect(messages.length).toBe(5)
  })
})
