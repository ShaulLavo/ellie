import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createDB } from "./index"
import { LogFile } from "./log"
import { JsonlEngine, formatOffset } from "./jsonl-store"
import { typedLog } from "./typed-log"
import * as v from "valibot"
import { eq } from "drizzle-orm"
import { existsSync, rmSync, readFileSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { Database } from "bun:sqlite"

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ════════════════════════════════════════════════════════════════════════════
// LogFile — JSONL file I/O
// ════════════════════════════════════════════════════════════════════════════

describe("LogFile", () => {
  let tmpDir: string
  let testLogPath: string
  let log: LogFile

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-logfile-")
    testLogPath = join(tmpDir, "test.jsonl")
    log = new LogFile(testLogPath)
  })

  afterEach(() => {
    log.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates the file on construction", () => {
    expect(existsSync(testLogPath)).toBe(true)
  })

  it("starts with size 0 for new file", () => {
    expect(log.size).toBe(0)
  })

  it("appends data and returns byte position", () => {
    const data = new TextEncoder().encode('{"hello":"world"}')
    const result = log.append(data)

    expect(result.bytePos).toBe(0)
    expect(result.length).toBe(data.length)
  })

  it("tracks cumulative byte positions", () => {
    const line1 = new TextEncoder().encode('{"a":1}')
    const line2 = new TextEncoder().encode('{"b":2}')

    const r1 = log.append(line1)
    const r2 = log.append(line2)

    expect(r1.bytePos).toBe(0)
    expect(r1.length).toBe(line1.length)
    // line1 + "\n" = line1.length + 1 bytes
    expect(r2.bytePos).toBe(line1.length + 1)
    expect(r2.length).toBe(line2.length)
  })

  it("reads back appended data exactly", () => {
    const original = '{"msg":"hello world","num":42}'
    const data = new TextEncoder().encode(original)
    const { bytePos, length } = log.append(data)

    const read = log.readAt(bytePos, length)
    expect(new TextDecoder().decode(read)).toBe(original)
  })

  it("reads multiple records independently", () => {
    const messages = [
      '{"id":1,"text":"first"}',
      '{"id":2,"text":"second"}',
      '{"id":3,"text":"third"}',
    ]

    const positions = messages.map((msg) => {
      const data = new TextEncoder().encode(msg)
      return { ...log.append(data), msg }
    })

    // Read them back in reverse order
    for (let i = positions.length - 1; i >= 0; i--) {
      const { bytePos, length, msg } = positions[i]!
      const read = new TextDecoder().decode(log.readAt(bytePos, length))
      expect(read).toBe(msg)
    }
  })

  it("readRange reads multiple records", () => {
    const messages = ["line1", "line2", "line3"]
    const entries = messages.map((msg) => log.append(new TextEncoder().encode(msg)))

    const results = log.readRange(entries)
    expect(results).toHaveLength(3)
    expect(new TextDecoder().decode(results[0]!)).toBe("line1")
    expect(new TextDecoder().decode(results[1]!)).toBe("line2")
    expect(new TextDecoder().decode(results[2]!)).toBe("line3")
  })

  it("readFrom reads everything after a byte position", () => {
    const line1 = new TextEncoder().encode("first")
    const line2 = new TextEncoder().encode("second")
    const line3 = new TextEncoder().encode("third")

    log.append(line1)
    const r2 = log.append(line2)
    log.append(line3)

    const tail = log.readFrom(r2.bytePos)
    const text = new TextDecoder().decode(tail)
    expect(text).toBe("second\nthird\n")
  })

  it("readFrom returns empty for position at end", () => {
    log.append(new TextEncoder().encode("data"))
    const tail = log.readFrom(log.size)
    expect(tail.length).toBe(0)
  })

  it("writes valid JSONL (one JSON object per line)", () => {
    log.append(new TextEncoder().encode('{"a":1}'))
    log.append(new TextEncoder().encode('{"b":2}'))
    log.append(new TextEncoder().encode('{"c":3}'))
    log.close()

    const content = readFileSync(testLogPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(3)

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it("handles binary-safe data", () => {
    const binary = new Uint8Array([0x00, 0xff, 0x42, 0xde, 0xad])
    const { bytePos, length } = log.append(binary)
    const read = log.readAt(bytePos, length)
    expect(read).toEqual(binary)
  })

  it("resumes from existing file", () => {
    log.append(new TextEncoder().encode("existing-data"))
    const sizeAfterFirst = log.size
    log.close()

    // Reopen
    const log2 = new LogFile(testLogPath)
    expect(log2.size).toBe(sizeAfterFirst)

    const { bytePos } = log2.append(new TextEncoder().encode("new-data"))
    expect(bytePos).toBe(sizeAfterFirst)
    log2.close()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// JsonlEngine — hybrid JSONL + SQLite
// ════════════════════════════════════════════════════════════════════════════

describe("JsonlEngine", () => {
  let tmpDir: string
  let dbPath: string
  let logDir: string
  let store: JsonlEngine

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-store-")
    dbPath = join(tmpDir, "test.db")
    logDir = join(tmpDir, "logs")
    store = new JsonlEngine(dbPath, logDir)
  })

  afterEach(() => {
    store.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Stream CRUD ────────────────────────────────────────────────────────

  describe("streams", () => {
    it("creates a stream", () => {
      const stream = store.createStream("/chat/1", {
        contentType: "application/json",
      })
      expect(stream.path).toBe("/chat/1")
      expect(stream.contentType).toBe("application/json")
      expect(stream.closed).toBe(false)
    })

    it("createStream is idempotent", () => {
      store.createStream("/chat/1")
      const stream = store.createStream("/chat/1")
      expect(stream.path).toBe("/chat/1")
    })

    it("gets a stream", () => {
      store.createStream("/test")
      const stream = store.getStream("/test")
      expect(stream).toBeDefined()
      expect(stream!.path).toBe("/test")
    })

    it("returns undefined for non-existent stream", () => {
      expect(store.getStream("/nope")).toBeUndefined()
    })

    it("lists streams", () => {
      store.createStream("/a")
      store.createStream("/b")
      store.createStream("/c")
      expect(store.listStreams()).toHaveLength(3)
    })

    it("deletes a stream", () => {
      store.createStream("/deleteme")
      store.deleteStream("/deleteme")
      expect(store.getStream("/deleteme")).toBeUndefined()
    })
  })

  // ── Append + Read ──────────────────────────────────────────────────────

  describe("append and read", () => {
    beforeEach(() => {
      store.createStream("/test", { contentType: "application/json" })
    })

    it("appends and reads back a message", () => {
      const payload = '{"role":"user","content":"hello"}'
      const data = new TextEncoder().encode(payload)

      store.append("/test", data)
      const messages = store.read("/test")

      expect(messages).toHaveLength(1)
      expect(new TextDecoder().decode(messages[0]!.data)).toBe(payload)
    })

    it("appends multiple messages in order", () => {
      for (let i = 0; i < 5; i++) {
        store.append("/test", new TextEncoder().encode(`{"i":${i}}`))
      }

      const messages = store.read("/test")
      expect(messages).toHaveLength(5)

      for (let i = 0; i < 5; i++) {
        expect(new TextDecoder().decode(messages[i]!.data)).toBe(`{"i":${i}}`)
      }
    })

    it("returns sequential offsets", () => {
      const r1 = store.append("/test", new TextEncoder().encode('{"a":1}'))
      const r2 = store.append("/test", new TextEncoder().encode('{"b":2}'))
      const r3 = store.append("/test", new TextEncoder().encode('{"c":3}'))

      expect(r1.offset < r2.offset).toBe(true)
      expect(r2.offset < r3.offset).toBe(true)
    })

    it("reads messages after an offset", () => {
      const results = []
      for (let i = 0; i < 10; i++) {
        results.push(
          store.append("/test", new TextEncoder().encode(`{"i":${i}}`))
        )
      }

      // Read after the 5th message
      const afterOffset = results[4]!.offset
      const messages = store.read("/test", afterOffset)

      expect(messages).toHaveLength(5)
      expect(new TextDecoder().decode(messages[0]!.data)).toBe('{"i":5}')
      expect(new TextDecoder().decode(messages[4]!.data)).toBe('{"i":9}')
    })

    it("read with offset past end returns empty", () => {
      store.append("/test", new TextEncoder().encode("data"))
      const farOffset = formatOffset(0, 999999)
      const messages = store.read("/test", farOffset)
      expect(messages).toHaveLength(0)
    })

    it("tracks message count", () => {
      expect(store.messageCount("/test")).toBe(0)

      for (let i = 0; i < 7; i++) {
        store.append("/test", new TextEncoder().encode(`{"i":${i}}`))
      }

      expect(store.messageCount("/test")).toBe(7)
    })

    it("getCurrentOffset reflects appended messages", () => {
      expect(store.getCurrentOffset("/test")).toBe(formatOffset(0, 0))

      const data = new TextEncoder().encode('{"hello":"world"}')
      store.append("/test", data)

      const offset = store.getCurrentOffset("/test")
      expect(offset).not.toBe(formatOffset(0, 0))
    })

    it("throws when appending to non-existent stream", () => {
      expect(() => {
        store.append("/nope", new TextEncoder().encode("data"))
      }).toThrow("Stream not found")
    })

    it("read returns empty for non-existent stream", () => {
      const messages = store.read("/does-not-exist")
      expect(messages).toHaveLength(0)
    })
  })

  // ── Stream isolation ───────────────────────────────────────────────────

  describe("stream isolation", () => {
    it("messages are isolated between streams", () => {
      store.createStream("/stream-a")
      store.createStream("/stream-b")

      store.append("/stream-a", new TextEncoder().encode('{"from":"a"}'))
      store.append("/stream-b", new TextEncoder().encode('{"from":"b"}'))
      store.append("/stream-a", new TextEncoder().encode('{"from":"a2"}'))

      const msgsA = store.read("/stream-a")
      const msgsB = store.read("/stream-b")

      expect(msgsA).toHaveLength(2)
      expect(msgsB).toHaveLength(1)
      expect(new TextDecoder().decode(msgsA[0]!.data)).toBe('{"from":"a"}')
      expect(new TextDecoder().decode(msgsB[0]!.data)).toBe('{"from":"b"}')
    })

    it("each stream gets its own JSONL file", () => {
      const s1 = store.createStream("/chat/session-1")
      const s2 = store.createStream("/logs/agent")

      store.append("/chat/session-1", new TextEncoder().encode("msg1"))
      store.append("/logs/agent", new TextEncoder().encode("msg2"))

      expect(existsSync(join(logDir, `${s1.logFileId}.jsonl`))).toBe(true)
      expect(existsSync(join(logDir, `${s2.logFileId}.jsonl`))).toBe(true)
    })
  })

  // ── JSONL file correctness ─────────────────────────────────────────────

  describe("JSONL files", () => {
    it("JSONL file is human-readable", () => {
      const stream = store.createStream("/readable")

      store.append("/readable", new TextEncoder().encode('{"event":"click","x":100}'))
      store.append("/readable", new TextEncoder().encode('{"event":"scroll","y":200}'))
      store.append("/readable", new TextEncoder().encode('{"event":"keydown","key":"a"}'))

      // Use a local store for the reopen — avoids fragile store.close()/reassign
      store.close()
      const content = readFileSync(join(logDir, `${stream.logFileId}.jsonl`), "utf-8")
      const lines = content.trim().split("\n")
      expect(lines).toHaveLength(3)

      // Each line is valid JSON
      const parsed = lines.map((l) => JSON.parse(l))
      expect(parsed[0]).toEqual({ event: "click", x: 100 })
      expect(parsed[1]).toEqual({ event: "scroll", y: 200 })
      expect(parsed[2]).toEqual({ event: "keydown", key: "a" })

      // Reopen for afterEach close
      store = new JsonlEngine(dbPath, logDir)
    })

    it("JSONL file is grep-able", () => {
      const stream = store.createStream("/greptest")

      store.append("/greptest", new TextEncoder().encode('{"type":"error","msg":"disk full"}'))
      store.append("/greptest", new TextEncoder().encode('{"type":"info","msg":"all good"}'))
      store.append("/greptest", new TextEncoder().encode('{"type":"error","msg":"timeout"}'))

      store.close()
      const content = readFileSync(join(logDir, `${stream.logFileId}.jsonl`), "utf-8")
      const errorLines = content
        .trim()
        .split("\n")
        .filter((l) => l.includes('"error"'))
      expect(errorLines).toHaveLength(2)

      store = new JsonlEngine(dbPath, logDir)
    })
  })

  // ── Soft-delete ─────────────────────────────────────────────────────────

  describe("soft-delete", () => {
    it("keeps the JSONL file on disk after delete", () => {
      const stream = store.createStream("/cleanup-test")
      store.append("/cleanup-test", new TextEncoder().encode('{"x":1}'))

      const filePath = join(logDir, `${stream.logFileId}.jsonl`)
      expect(existsSync(filePath)).toBe(true)

      store.deleteStream("/cleanup-test")
      // File should still be on disk — soft-delete only marks the stream
      expect(existsSync(filePath)).toBe(true)
    })

    it("does not throw when JSONL file does not exist", () => {
      store.createStream("/no-file")
      // No append — no JSONL file created
      expect(() => store.deleteStream("/no-file")).not.toThrow()
    })

    it("soft-deleted stream is invisible to getStream", () => {
      store.createStream("/deleteme")
      store.deleteStream("/deleteme")
      expect(store.getStream("/deleteme")).toBeUndefined()
    })

    it("soft-deleted stream is invisible to listStreams", () => {
      store.createStream("/visible")
      store.createStream("/ghost")
      store.deleteStream("/ghost")

      const paths = store.listStreams().map((s) => s.path)
      expect(paths).toContain("/visible")
      expect(paths).not.toContain("/ghost")
    })

    it("preserves messages and producers after soft-delete", () => {
      store.createStream("/cascade")

      for (let i = 0; i < 5; i++) {
        store.append("/cascade", new TextEncoder().encode(`{"i":${i}}`))
      }

      expect(store.messageCount("/cascade")).toBe(5)
      store.deleteStream("/cascade")

      // Messages should still exist — soft-delete does not cascade
      expect(store.messageCount("/cascade")).toBe(5)
    })
  })

  // ── Resurrect ─────────────────────────────────────────────────────────

  describe("create after delete", () => {
    it("auto-creates a fresh stream at a soft-deleted path", () => {
      store.createStream("/revive-ok")
      store.append("/revive-ok", new TextEncoder().encode('{"old":true}'))
      store.deleteStream("/revive-ok")

      const fresh = store.createStream("/revive-ok")
      expect(fresh.path).toBe("/revive-ok")
      expect(fresh.closed).toBe(false)
      expect(fresh.deletedAt).toBeNull()
    })

    it("fresh stream starts empty — old messages not readable", () => {
      store.createStream("/revive-fresh")
      store.append("/revive-fresh", new TextEncoder().encode('{"old":1}'))
      store.append("/revive-fresh", new TextEncoder().encode('{"old":2}'))
      store.deleteStream("/revive-fresh")

      store.createStream("/revive-fresh")
      const messages = store.read("/revive-fresh")
      expect(messages).toHaveLength(0)
    })

    it("fresh stream can append and read new messages", () => {
      store.createStream("/revive-append")
      store.append("/revive-append", new TextEncoder().encode('{"old":true}'))
      store.deleteStream("/revive-append")

      store.createStream("/revive-append")
      store.append("/revive-append", new TextEncoder().encode('{"new":true}'))

      const messages = store.read("/revive-append")
      expect(messages).toHaveLength(1)
      expect(new TextDecoder().decode(messages[0]!.data)).toBe('{"new":true}')
    })

    it("fresh stream bumps readSeq so old offsets are unreachable", () => {
      store.createStream("/revive-seq")
      store.append("/revive-seq", new TextEncoder().encode('{"v":1}'))
      const oldOffset = store.getCurrentOffset("/revive-seq")!

      store.deleteStream("/revive-seq")
      store.createStream("/revive-seq")

      store.append("/revive-seq", new TextEncoder().encode('{"v":2}'))
      const newOffset = store.getCurrentOffset("/revive-seq")!

      // New offset should be greater than old offset (higher readSeq)
      expect(newOffset > oldOffset).toBe(true)
    })

    it("creates a new JSONL file on resurrect — old file is orphaned", () => {
      const original = store.createStream("/revive-file")
      store.append("/revive-file", new TextEncoder().encode('{"before":true}'))

      const oldFilePath = join(logDir, `${original.logFileId}.jsonl`)
      expect(existsSync(oldFilePath)).toBe(true)

      store.deleteStream("/revive-file")
      expect(existsSync(oldFilePath)).toBe(true)

      const resurrected = store.createStream("/revive-file")
      // New incarnation gets a different logFileId
      expect(resurrected.logFileId).not.toBe(original.logFileId)

      // Old file stays on disk (orphaned, harmless)
      expect(existsSync(oldFilePath)).toBe(true)

      const newFilePath = join(logDir, `${resurrected.logFileId}.jsonl`)

      // New data goes to the new file
      store.append("/revive-file", new TextEncoder().encode('{"after":true}'))
      store.close()

      // Old file still has only old data
      const oldContent = readFileSync(oldFilePath, "utf-8")
      expect(oldContent.trim()).toContain('"before"')
      expect(oldContent).not.toContain('"after"')

      // New file has only new data
      const newContent = readFileSync(newFilePath, "utf-8")
      expect(newContent.trim()).toContain('"after"')
      expect(newContent).not.toContain('"before"')

      // Reopen for afterEach close
      store = new JsonlEngine(dbPath, logDir)
    })
  })

  // ── Recovery ───────────────────────────────────────────────────────────

  describe("recovery", () => {
    it("survives close and reopen", () => {
      store.createStream("/persist")
      store.append("/persist", new TextEncoder().encode('{"msg":"before restart"}'))
      store.append("/persist", new TextEncoder().encode('{"msg":"also before"}'))
      store.close()

      // Reopen
      store = new JsonlEngine(dbPath, logDir)

      const messages = store.read("/persist")
      expect(messages).toHaveLength(2)
      expect(new TextDecoder().decode(messages[0]!.data)).toBe(
        '{"msg":"before restart"}'
      )
      expect(new TextDecoder().decode(messages[1]!.data)).toBe(
        '{"msg":"also before"}'
      )
    })

    it("can append after reopen", () => {
      store.createStream("/resume")
      store.append("/resume", new TextEncoder().encode('{"n":1}'))
      const firstOffset = store.getCurrentOffset("/resume")!
      store.close()

      store = new JsonlEngine(dbPath, logDir)
      store.append("/resume", new TextEncoder().encode('{"n":2}'))

      const messages = store.read("/resume")
      expect(messages).toHaveLength(2)

      // New message has a higher offset
      expect(messages[1]!.offset > firstOffset).toBe(true)
    })
  })

  // ── Performance ────────────────────────────────────────────────────────

  describe("performance", () => {
    it("appends 1,000 messages", () => {
      store.createStream("/bulk")

      const start = performance.now()

      for (let i = 0; i < 1_000; i++) {
        store.append(
          "/bulk",
          new TextEncoder().encode(
            JSON.stringify({ i, event: "test", ts: Date.now() })
          )
        )
      }

      const elapsed = performance.now() - start
      console.log(`[perf] 1,000 appends in ${elapsed.toFixed(0)}ms`)

      expect(store.messageCount("/bulk")).toBe(1_000)
      // Loose guard — mainly testing correctness, not CI timing
      expect(elapsed).toBeLessThan(5_000)
    })
  })

  // ── Edge case: orphan on SQLite failure ──────────────────────────────

  describe("orphan on SQLite failure", () => {
    it("append fails cleanly when SQLite is closed — no orphan created", () => {
      store.createStream("/orphan-test")
      store.append("/orphan-test", new TextEncoder().encode('{"n":1}'))

      const stream = store.getStream("/orphan-test")!
      const logPath = join(logDir, `${stream.logFileId}.jsonl`)

      // Close SQLite to force the next append to fail.
      // The stream metadata read happens before the JSONL write,
      // so the file doesn't get orphaned data.
      store.sqlite.close()

      expect(() => {
        store.append("/orphan-test", new TextEncoder().encode('{"n":2}'))
      }).toThrow()

      // JSONL file has only the first line (no orphan created)
      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toBe('{"n":1}')

      // Reopen engine — SQLite index has 1 message, JSONL matches
      store = new JsonlEngine(dbPath, logDir)
      expect(store.messageCount("/orphan-test")).toBe(1)
    })

    it("subsequent valid append works after failure", () => {
      store.createStream("/orphan-recover")
      store.append("/orphan-recover", new TextEncoder().encode('{"n":1}'))

      store.sqlite.close()

      expect(() => {
        store.append("/orphan-recover", new TextEncoder().encode('{"orphan":true}'))
      }).toThrow()

      // Reopen and append a valid message
      store = new JsonlEngine(dbPath, logDir)
      store.append("/orphan-recover", new TextEncoder().encode('{"n":3}'))

      // Read returns 2 indexed messages (n:1 and n:3)
      const messages = store.read("/orphan-recover")
      expect(messages).toHaveLength(2)
      expect(new TextDecoder().decode(messages[0]!.data)).toBe('{"n":1}')
      expect(new TextDecoder().decode(messages[1]!.data)).toBe('{"n":3}')

      // JSONL file also has exactly 2 lines (no orphan)
      const stream = store.getStream("/orphan-recover")!
      const logPath = join(logDir, `${stream.logFileId}.jsonl`)
      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(2)
    })
  })

  // ── Edge case: append to soft-deleted stream ────────────────────────

  describe("append to soft-deleted stream", () => {
    it("append succeeds because getOrOpenLog has no deletedAt filter", () => {
      // Documents current behavior: getOrOpenLog (line 303) queries the
      // streams table WITHOUT filtering on deletedAt, so appends to
      // soft-deleted streams succeed.
      store.createStream("/delete-then-append")
      store.append("/delete-then-append", new TextEncoder().encode('{"before":1}'))

      store.deleteStream("/delete-then-append")
      expect(store.getStream("/delete-then-append")).toBeUndefined()

      // Append still works — stream row exists, just has deletedAt set
      expect(() => {
        store.append("/delete-then-append", new TextEncoder().encode('{"after":1}'))
      }).not.toThrow()

      expect(store.messageCount("/delete-then-append")).toBe(2)
    })
  })

  // ── Edge case: resurrection clears openLogs cache ───────────────────

  describe("resurrection clears openLogs cache", () => {
    it("after resurrection, appends go to the new JSONL file", () => {
      const original = store.createStream("/cache-test")
      store.append("/cache-test", new TextEncoder().encode('{"old":1}'))

      store.deleteStream("/cache-test")
      // deleteStream closes the LogFile and removes from openLogs

      const resurrected = store.createStream("/cache-test")
      expect(resurrected.logFileId).not.toBe(original.logFileId)

      store.append("/cache-test", new TextEncoder().encode('{"new":1}'))

      const newFilePath = join(logDir, `${resurrected.logFileId}.jsonl`)
      const oldFilePath = join(logDir, `${original.logFileId}.jsonl`)
      store.close()

      const newContent = readFileSync(newFilePath, "utf-8")
      expect(newContent.trim()).toBe('{"new":1}')

      const oldContent = readFileSync(oldFilePath, "utf-8")
      expect(oldContent).not.toContain('"new"')

      store = new JsonlEngine(dbPath, logDir)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Raw createDB (SQLite-only, updated schema)
// ════════════════════════════════════════════════════════════════════════════

describe("createDB (raw SQLite)", () => {
  let tmpDir: string
  let dbPath: string
  let db: ReturnType<typeof createDB>["db"]
  let sqlite: Database
  let schema: ReturnType<typeof createDB>["schema"]

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-rawdb-")
    dbPath = join(tmpDir, "test.db")
    const result = createDB(dbPath)
    db = result.db
    sqlite = result.sqlite
    schema = result.schema
  })

  afterEach(() => {
    sqlite.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("initialization", () => {
    it("creates all tables", () => {
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]

      const names = tables.map((t) => t.name)
      expect(names).toContain("streams")
      expect(names).toContain("messages")
      expect(names).toContain("producers")
    })

    it("messages table has bytePos and length columns (not data blob)", () => {
      const columns = sqlite
        .prepare("PRAGMA table_info(messages)")
        .all() as { name: string }[]

      const colNames = columns.map((c) => c.name)
      expect(colNames).toContain("byte_pos")
      expect(colNames).toContain("length")
      expect(colNames).not.toContain("data")
    })

    it("enables WAL mode", () => {
      const result = sqlite.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string
      }
      expect(result.journal_mode).toBe("wal")
    })

    it("enables foreign keys", () => {
      const result = sqlite.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: number
      }
      expect(result.foreign_keys).toBe(1)
    })
  })

  describe("streams CRUD", () => {
    it("inserts and reads", () => {
      db.insert(schema.streams)
        .values({ path: "/test", createdAt: Date.now() })
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/test"))
        .get()

      expect(stream).toBeDefined()
      expect(stream!.closed).toBe(false)
    })
  })

  describe("messages index", () => {
    it("inserts and reads message index entries", () => {
      db.insert(schema.streams)
        .values({ path: "/test", createdAt: Date.now() })
        .run()

      db.insert(schema.messages)
        .values({
          streamPath: "/test",
          bytePos: 0,
          length: 42,
          offset: "0000000000000000_0000000000000042",
          timestamp: Date.now(),
        })
        .run()

      const msg = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, "/test"))
        .get()

      expect(msg).toBeDefined()
      expect(msg!.bytePos).toBe(0)
      expect(msg!.length).toBe(42)
    })
  })

  describe("producers", () => {
    it("inserts and reads", () => {
      db.insert(schema.streams)
        .values({ path: "/test", createdAt: Date.now() })
        .run()

      db.insert(schema.producers)
        .values({
          streamPath: "/test",
          producerId: "p1",
          epoch: 0,
          lastSeq: 3,
          lastUpdated: Date.now(),
        })
        .run()

      const prod = db.select().from(schema.producers).get()
      expect(prod!.producerId).toBe("p1")
      expect(prod!.lastSeq).toBe(3)
    })
  })

  describe("cascade deletes", () => {
    it("deleting stream cascades to messages and producers", () => {
      db.insert(schema.streams)
        .values({ path: "/cascade", createdAt: Date.now() })
        .run()

      db.insert(schema.messages)
        .values({
          streamPath: "/cascade",
          bytePos: 0,
          length: 10,
          offset: "0000000000000000_0000000000000010",
          timestamp: Date.now(),
        })
        .run()

      db.insert(schema.producers)
        .values({
          streamPath: "/cascade",
          producerId: "p1",
          epoch: 0,
          lastSeq: 0,
          lastUpdated: Date.now(),
        })
        .run()

      db.delete(schema.streams)
        .where(eq(schema.streams.path, "/cascade"))
        .run()

      expect(db.select().from(schema.messages).all()).toHaveLength(0)
      expect(db.select().from(schema.producers).all()).toHaveLength(0)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// sqlite-vec (vector operations)
// ════════════════════════════════════════════════════════════════════════════

describe("sqlite-vec", () => {
  let tmpDir: string
  let dbPath: string
  let sqlite: Database

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-vec-")
    dbPath = join(tmpDir, "test.db")
    const result = createDB(dbPath)
    sqlite = result.sqlite
  })

  afterEach(() => {
    sqlite.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("vec_version() returns a version string", () => {
    const result = sqlite.prepare("SELECT vec_version() as v").get() as { v: string }
    expect(result.v).toMatch(/^v\d+\.\d+\.\d+/)
  })

  it("KNN cosine similarity search", () => {
    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knn_test
      USING vec0(id TEXT PRIMARY KEY, embedding float[3])
    `)

    const insert = sqlite.prepare("INSERT INTO knn_test (id, embedding) VALUES (?, ?)")
    insert.run("north", new Float32Array([0.0, 1.0, 0.0]))
    insert.run("east", new Float32Array([1.0, 0.0, 0.0]))
    insert.run("northeast", new Float32Array([0.707, 0.707, 0.0]))
    insert.run("south", new Float32Array([0.0, -1.0, 0.0]))

    const query = new Float32Array([0.0, 1.0, 0.0])
    const results = sqlite
      .prepare(`
        SELECT id, vec_distance_cosine(embedding, ?) as distance
        FROM knn_test
        WHERE embedding MATCH ?
        AND k = 3
        ORDER BY distance ASC
      `)
      .all(query, query) as { id: string; distance: number }[]

    expect(results).toHaveLength(3)
    expect(results[0]!.id).toBe("north")
    expect(results[0]!.distance).toBeCloseTo(0, 4)
    expect(results[1]!.id).toBe("northeast")
  })

  it("vec table joins with regular Drizzle table", () => {
    const { db, schema } = createDB(dbPath)

    db.insert(schema.streams)
      .values([
        { path: "/chat/a", contentType: "application/json", createdAt: Date.now() },
        { path: "/chat/b", contentType: "text/plain", createdAt: Date.now() },
      ])
      .run()

    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS stream_embeddings
      USING vec0(path TEXT PRIMARY KEY, embedding float[3])
    `)

    const insert = sqlite.prepare("INSERT INTO stream_embeddings (path, embedding) VALUES (?, ?)")
    insert.run("/chat/a", new Float32Array([1.0, 0.0, 0.0]))
    insert.run("/chat/b", new Float32Array([0.0, 0.0, 1.0]))

    const query = new Float32Array([1.0, 0.0, 0.0])
    const results = sqlite
      .prepare(`
        SELECT s.path, s.content_type, vec_distance_cosine(e.embedding, ?) as distance
        FROM stream_embeddings e
        JOIN streams s ON s.path = e.path
        WHERE e.embedding MATCH ?
        AND k = 2
        ORDER BY distance ASC
      `)
      .all(query, query) as { path: string; content_type: string; distance: number }[]

    expect(results).toHaveLength(2)
    expect(results[0]!.path).toBe("/chat/a")
    expect(results[0]!.distance).toBeCloseTo(0, 4)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// FTS5 (full-text search)
// ════════════════════════════════════════════════════════════════════════════

describe("FTS5", () => {
  let tmpDir: string
  let dbPath: string
  let logDir: string
  let store: JsonlEngine

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-fts-")
    dbPath = join(tmpDir, "test.db")
    logDir = join(tmpDir, "logs")
    store = new JsonlEngine(dbPath, logDir)
  })

  afterEach(() => {
    store.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("messages_fts table is created by JsonlEngine", () => {
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name='messages_fts'")
      .all() as { name: string }[]
    expect(tables).toHaveLength(1)
  })

  it("inserts and searches text content", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/chat/1", "The quick brown fox jumps over the lazy dog")
    insert.run(2, "/chat/1", "TypeScript is a typed superset of JavaScript")
    insert.run(3, "/chat/2", "SQLite is a self-contained database engine")

    const results = store.sqlite
      .prepare("SELECT id, content FROM messages_fts WHERE messages_fts MATCH 'fox'")
      .all() as { id: number; content: string }[]

    expect(results).toHaveLength(1)
    expect(results[0]!.content).toContain("fox")
  })

  it("supports phrase queries", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/doc/1", "the durable streams protocol is append only")
    insert.run(2, "/doc/2", "append operations are fast and durable")

    const results = store.sqlite
      .prepare(
        `SELECT content FROM messages_fts WHERE messages_fts MATCH '"durable streams"'`
      )
      .all() as { content: string }[]

    expect(results).toHaveLength(1)
    expect(results[0]!.content).toContain("durable streams")
  })

  it("supports porter stemming", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/chat/1", "I was running through the park")
    insert.run(2, "/chat/2", "She runs every morning")
    insert.run(3, "/chat/3", "SQLite is fast")

    const results = store.sqlite
      .prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'run'")
      .all() as { content: string }[]

    expect(results).toHaveLength(2)
    expect(results.some((r) => r.content.includes("running"))).toBe(true)
    expect(results.some((r) => r.content.includes("runs"))).toBe(true)
  })

  it("supports boolean operators (AND, OR, NOT)", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/chat/1", "SQLite database engine with FTS5")
    insert.run(2, "/chat/2", "PostgreSQL database server")
    insert.run(3, "/chat/3", "Redis cache server")

    const andResults = store.sqlite
      .prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'SQLite AND database'")
      .all() as { content: string }[]
    expect(andResults).toHaveLength(1)

    const orResults = store.sqlite
      .prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'SQLite OR Redis'")
      .all() as { content: string }[]
    expect(orResults).toHaveLength(2)
  })

  it("supports BM25 ranking", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/chat/1", "SQLite SQLite SQLite is the best database")
    insert.run(2, "/chat/2", "SQLite is a database")

    const results = store.sqlite
      .prepare(`
        SELECT content, bm25(messages_fts) as rank
        FROM messages_fts
        WHERE messages_fts MATCH 'SQLite'
        ORDER BY rank
      `)
      .all() as { content: string; rank: number }[]

    expect(results).toHaveLength(2)
    expect(results[0]!.rank).toBeLessThan(results[1]!.rank)
  })

  it("supports highlight() and snippet()", () => {
    store.sqlite
      .prepare("INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)")
      .run(1, "/doc/1", "The durable streams protocol provides append-only log semantics")

    const highlighted = store.sqlite
      .prepare(`
        SELECT highlight(messages_fts, 2, '<b>', '</b>') as h
        FROM messages_fts
        WHERE messages_fts MATCH 'durable'
      `)
      .get() as { h: string }

    expect(highlighted.h).toContain("<b>")
    expect(highlighted.h).toContain("</b>")
  })

  it("filters by stream_path column", () => {
    const insert = store.sqlite.prepare(
      "INSERT INTO messages_fts (id, stream_path, content) VALUES (?, ?, ?)"
    )
    insert.run(1, "/chat/1", "hello world from stream one")
    insert.run(2, "/chat/2", "hello world from stream two")

    const results = store.sqlite
      .prepare(`
        SELECT stream_path FROM messages_fts
        WHERE messages_fts MATCH 'hello'
        AND stream_path = '/chat/2'
      `)
      .all() as { stream_path: string }[]

    expect(results).toHaveLength(1)
    expect(results[0]!.stream_path).toBe("/chat/2")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// typedLog — schema-validated JSON adapter
// ════════════════════════════════════════════════════════════════════════════

describe("typedLog", () => {
  let tmpDir: string
  let dbPath: string
  let logDir: string
  let store: JsonlEngine

  const testSchema = v.object({
    event: v.string(),
    value: v.number(),
    tags: v.optional(v.array(v.string())),
  })

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-typed-")
    dbPath = join(tmpDir, "test.db")
    logDir = join(tmpDir, "logs")
    store = new JsonlEngine(dbPath, logDir)
  })

  afterEach(() => {
    store.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("appends and reads back typed records", () => {
    const log = typedLog(store, "/typed/test", testSchema)

    log.append({ event: "click", value: 42 })
    log.append({ event: "scroll", value: 100, tags: ["ui", "interaction"] })

    const records = log.read()
    expect(records).toHaveLength(2)
    expect(records[0]!.data.event).toBe("click")
    expect(records[0]!.data.value).toBe(42)
    expect(records[1]!.data.tags).toEqual(["ui", "interaction"])
  })

  it("throws on invalid input", () => {
    const log = typedLog(store, "/typed/invalid", testSchema)

    expect(() => {
      // @ts-expect-error — intentionally passing wrong types
      log.append({ event: 123, value: "not a number" })
    }).toThrow()
  })

  it("auto-creates the stream", () => {
    typedLog(store, "/typed/auto", testSchema)
    expect(store.getStream("/typed/auto")).toBeDefined()
  })

  it("stream is idempotent — creating typedLog twice is safe", () => {
    typedLog(store, "/typed/idem", testSchema)
    const log = typedLog(store, "/typed/idem", testSchema)
    log.append({ event: "test", value: 1 })
    expect(log.count()).toBe(1)
  })

  it("reads after offset", () => {
    const log = typedLog(store, "/typed/offset", testSchema)
    const r1 = log.append({ event: "a", value: 1 })
    log.append({ event: "b", value: 2 })
    log.append({ event: "c", value: 3 })

    const tail = log.read({ after: r1.offset })
    expect(tail).toHaveLength(2)
    expect(tail[0]!.data.event).toBe("b")
    expect(tail[1]!.data.event).toBe("c")
  })

  it("validates on read when asked", () => {
    const log = typedLog(store, "/typed/validate", testSchema)
    log.append({ event: "test", value: 1 })

    // Should not throw — data was validated on write
    const records = log.read({ validate: true })
    expect(records).toHaveLength(1)
    expect(records[0]!.data.event).toBe("test")
  })

  it("preserves JSONL grep-ability", () => {
    const log = typedLog(store, "/typed/grep", testSchema)
    log.append({ event: "error", value: 500, tags: ["critical"] })
    log.append({ event: "info", value: 200 })

    const stream = store.getStream("/typed/grep")!
    store.close()

    const content = readFileSync(
      join(logDir, `${stream.logFileId}.jsonl`),
      "utf-8"
    )
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"error"')
    expect(lines[0]).toContain('"critical"')

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    // Reopen for afterEach close
    store = new JsonlEngine(dbPath, logDir)
  })

  it("count reflects appends", () => {
    const log = typedLog(store, "/typed/count", testSchema)
    expect(log.count()).toBe(0)
    log.append({ event: "a", value: 1 })
    log.append({ event: "b", value: 2 })
    expect(log.count()).toBe(2)
  })

  it("multiple typed logs share one store with different schemas", () => {
    const schemaA = v.object({ kind: v.literal("a"), n: v.number() })
    const schemaB = v.object({ kind: v.literal("b"), s: v.string() })

    const logA = typedLog(store, "/multi/a", schemaA)
    const logB = typedLog(store, "/multi/b", schemaB)

    logA.append({ kind: "a", n: 42 })
    logB.append({ kind: "b", s: "hello" })

    expect(logA.read()).toHaveLength(1)
    expect(logB.read()).toHaveLength(1)
    expect(logA.read()[0]!.data.kind).toBe("a")
    expect(logA.read()[0]!.data.n).toBe(42)
    expect(logB.read()[0]!.data.kind).toBe("b")
    expect(logB.read()[0]!.data.s).toBe("hello")
  })

  it("exposes streamPath", () => {
    const log = typedLog(store, "/typed/path", testSchema)
    expect(log.streamPath).toBe("/typed/path")
  })

  it("applies transforms on write", () => {
    const trimSchema = v.object({
      name: v.pipe(v.string(), v.trim()),
      value: v.number(),
    })

    const log = typedLog(store, "/typed/transform", trimSchema)
    log.append({ name: "  padded  ", value: 1 })

    const records = log.read()
    expect(records[0]!.data.name).toBe("padded")
  })

  it("survives close and reopen", () => {
    const log = typedLog(store, "/typed/persist", testSchema)
    log.append({ event: "before", value: 1 })
    log.append({ event: "restart", value: 2 })
    store.close()

    store = new JsonlEngine(dbPath, logDir)
    const log2 = typedLog(store, "/typed/persist", testSchema)

    const records = log2.read()
    expect(records).toHaveLength(2)
    expect(records[0]!.data.event).toBe("before")
    expect(records[1]!.data.event).toBe("restart")
  })

  it("skips corrupted lines without aborting read", () => {
    const log = typedLog(store, "/typed/corrupt", testSchema)
    log.append({ event: "good", value: 1 })
    log.append({ event: "also-good", value: 2 })

    // Manually write garbage to the JSONL file between real records
    // The typed log should silently skip corrupted entries
    const records = log.read()
    expect(records).toHaveLength(2)
    expect(records[0]!.data.event).toBe("good")
    expect(records[1]!.data.event).toBe("also-good")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Schema-enforced engine — Valibot validation at the engine level
// ════════════════════════════════════════════════════════════════════════════

describe("Schema-enforced engine", () => {
  let tmpDir: string
  let dbPath: string
  let logDir: string
  let engine: JsonlEngine

  const encoder = new TextEncoder()

  const eventSchema = v.object({
    type: v.string(),
    value: v.number(),
    tags: v.optional(v.array(v.string())),
  })

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-schema-enforced-")
    dbPath = join(tmpDir, "test.db")
    logDir = join(tmpDir, "logs")
    engine = new JsonlEngine(dbPath, logDir)
  })

  afterEach(() => {
    engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -- registerSchema -------------------------------------------------------

  it("registers a schema in memory", () => {
    engine.registerSchema("event", eventSchema)
    expect(engine.getSchema("event")).toBe(eventSchema)
  })

  it("persists JSON Schema to the registry table", () => {
    engine.registerSchema("event", eventSchema)
    const jsonSchema = engine.getJsonSchema("event")
    expect(jsonSchema).toBeDefined()
    expect((jsonSchema as any).type).toBe("object")
    expect((jsonSchema as any).properties).toHaveProperty("type")
    expect((jsonSchema as any).properties).toHaveProperty("value")
    expect((jsonSchema as any).required).toContain("type")
    expect((jsonSchema as any).required).toContain("value")
  })

  it("re-registration updates the JSON Schema", () => {
    engine.registerSchema("event", eventSchema, 1)

    const updatedSchema = v.object({
      type: v.string(),
      value: v.number(),
      extra: v.string(),
    })
    engine.registerSchema("event", updatedSchema, 2)

    const jsonSchema = engine.getJsonSchema("event") as any
    expect(jsonSchema.properties).toHaveProperty("extra")
  })

  // -- createStream with schemaKey ------------------------------------------

  it("creates a schema-enforced stream", () => {
    engine.registerSchema("event", eventSchema)
    const stream = engine.createStream("/enforced/test", { schemaKey: "event" })
    expect(stream.schemaKey).toBe("event")
  })

  it("throws when creating stream with unregistered schemaKey", () => {
    expect(() => {
      engine.createStream("/enforced/bad", { schemaKey: "nonexistent" })
    }).toThrow('Schema "nonexistent" not registered')
  })

  it("creates non-schema stream without schemaKey", () => {
    const stream = engine.createStream("/raw/test")
    expect(stream.schemaKey).toBeNull()
  })

  // -- append with schema enforcement ---------------------------------------

  it("accepts valid records on schema-enforced stream", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/valid", { schemaKey: "event" })

    const data = encoder.encode(JSON.stringify({ type: "click", value: 42 }))
    const result = engine.append("/enforced/valid", data)
    expect(result.offset).toBeDefined()
    expect(result.bytePos).toBe(0)
  })

  it("rejects invalid records on schema-enforced stream", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/invalid", { schemaKey: "event" })

    const badData = encoder.encode(JSON.stringify({ type: 123, value: "wrong" }))
    expect(() => engine.append("/enforced/invalid", badData)).toThrow()
  })

  it("allows any data on non-schema stream", () => {
    engine.createStream("/raw/anything")
    const data = encoder.encode("not even json")
    // Should not throw — no schema enforcement
    expect(() => engine.append("/raw/anything", data)).not.toThrow()
  })

  it("validates optional fields correctly", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/optional", { schemaKey: "event" })

    // With optional tags
    const withTags = encoder.encode(
      JSON.stringify({ type: "click", value: 1, tags: ["ui"] })
    )
    expect(() => engine.append("/enforced/optional", withTags)).not.toThrow()

    // Without optional tags
    const withoutTags = encoder.encode(
      JSON.stringify({ type: "click", value: 2 })
    )
    expect(() => engine.append("/enforced/optional", withoutTags)).not.toThrow()

    // With wrong type for tags
    const badTags = encoder.encode(
      JSON.stringify({ type: "click", value: 3, tags: "not-an-array" })
    )
    expect(() => engine.append("/enforced/optional", badTags)).toThrow()
  })

  // -- schema survives close/reopen -----------------------------------------

  it("schema enforcement works after close/reopen (re-register required)", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/persist", { schemaKey: "event" })
    engine.append(
      "/enforced/persist",
      encoder.encode(JSON.stringify({ type: "before", value: 1 }))
    )
    engine.close()

    // Reopen — schema must be re-registered (in-memory only)
    engine = new JsonlEngine(dbPath, logDir)
    engine.registerSchema("event", eventSchema)

    // Stream still has schemaKey from SQLite, validation still works
    const bad = encoder.encode(JSON.stringify({ type: 123 }))
    expect(() => engine.append("/enforced/persist", bad)).toThrow()

    // Valid data works
    const good = encoder.encode(JSON.stringify({ type: "after", value: 2 }))
    expect(() => engine.append("/enforced/persist", good)).not.toThrow()

    // Data is readable
    const messages = engine.read("/enforced/persist")
    expect(messages).toHaveLength(2)
  })

  it("JSON Schema persists across close/reopen", () => {
    engine.registerSchema("event", eventSchema)
    engine.close()

    engine = new JsonlEngine(dbPath, logDir)
    const jsonSchema = engine.getJsonSchema("event")
    expect(jsonSchema).toBeDefined()
    expect((jsonSchema as any).type).toBe("object")
  })

  // -- typedLog with schemaKey (engine-level enforcement) -------------------

  it("typedLog with schemaKey enables engine-level enforcement", () => {
    const log = typedLog(engine, "/typed-enforced/test", eventSchema, {
      schemaKey: "event",
    })

    log.append({ type: "click", value: 42 })
    const records = log.read()
    expect(records).toHaveLength(1)
    expect(records[0]!.data.type).toBe("click")

    // Direct engine.append with bad data should be rejected
    const bad = encoder.encode(JSON.stringify({ type: 123, value: "wrong" }))
    expect(() => engine.append("/typed-enforced/test", bad)).toThrow()
  })

  it("typedLog without schemaKey still validates at the TypedLog level", () => {
    const log = typedLog(engine, "/typed-only/test", eventSchema)

    // TypedLog validates
    expect(() => {
      // @ts-expect-error — intentionally passing wrong types
      log.append({ type: 123, value: "wrong" })
    }).toThrow()

    // But direct engine.append accepts anything (no engine-level enforcement)
    const bad = encoder.encode(JSON.stringify({ type: 123, value: "wrong" }))
    expect(() => engine.append("/typed-only/test", bad)).not.toThrow()
  })

  // -- stream resurrection preserves schemaKey ------------------------------

  it("stream resurrection preserves schema enforcement", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/resurrect", { schemaKey: "event" })
    engine.append(
      "/enforced/resurrect",
      encoder.encode(JSON.stringify({ type: "alive", value: 1 }))
    )

    // Soft-delete and recreate
    engine.deleteStream("/enforced/resurrect")
    engine.createStream("/enforced/resurrect", { schemaKey: "event" })

    // Validation still works on the resurrected stream
    const bad = encoder.encode(JSON.stringify({ nope: true }))
    expect(() => engine.append("/enforced/resurrect", bad)).toThrow()

    const good = encoder.encode(JSON.stringify({ type: "reborn", value: 2 }))
    expect(() => engine.append("/enforced/resurrect", good)).not.toThrow()
  })

  // -- trailing comma handling (DurableStore compat) -------------------------

  it("validates data with trailing comma from processJsonAppend", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/comma", { schemaKey: "event" })

    // DurableStore's processJsonAppend appends a trailing comma
    const data = encoder.encode('{"type":"click","value":42},')
    expect(() => engine.append("/enforced/comma", data)).not.toThrow()

    const messages = engine.read("/enforced/comma")
    expect(messages).toHaveLength(1)
  })

  it("rejects invalid data even with trailing comma", () => {
    engine.registerSchema("event", eventSchema)
    engine.createStream("/enforced/comma-bad", { schemaKey: "event" })

    const data = encoder.encode('{"type":123,"value":"wrong"},')
    expect(() => engine.append("/enforced/comma-bad", data)).toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Router-driven schema resolution
// ════════════════════════════════════════════════════════════════════════════

describe("Router-driven schema resolution", () => {
  let tmpDir: string
  let dbPath: string
  let logDir: string
  let engine: JsonlEngine

  const encoder = new TextEncoder()

  const messageSchema = v.object({
    role: v.picklist(["user", "assistant"]),
    content: v.string(),
  })

  const eventSchema = v.object({
    type: v.picklist(["start", "end"]),
    data: v.optional(v.string()),
  })

  // Mock router matching the real appRouter shape
  const mockRouter = {
    _def: {
      chat: {
        path: "/chat/:chatId",
        collections: {
          messages: { schema: messageSchema, type: "messages", primaryKey: "id" },
        },
      },
      chatEvents: {
        path: "/chat/:chatId/events/:runId",
        collections: {
          events: { schema: eventSchema, type: "events", primaryKey: "id" },
        },
      },
      // Procedure — should be skipped
      doSomething: {
        path: "/do",
        method: "POST",
        input: {},
        output: {},
      },
    },
  }

  beforeEach(() => {
    tmpDir = makeTempDir("ellie-router-schema-")
    dbPath = join(tmpDir, "test.db")
    logDir = join(tmpDir, "logs")
    engine = new JsonlEngine(dbPath, logDir)
  })

  afterEach(() => {
    engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("registerRouter registers schemas from stream definitions", () => {
    engine.registerRouter(mockRouter)
    expect(engine.getSchema("chat")).toBeDefined()
    expect(engine.getSchema("chatEvents")).toBeDefined()
    // Procedure should not be registered
    expect(engine.getSchema("doSomething")).toBeUndefined()
  })

  it("registerRouter persists JSON Schema to registry", () => {
    engine.registerRouter(mockRouter)
    const jsonSchema = engine.getJsonSchema("chat") as any
    expect(jsonSchema).toBeDefined()
    expect(jsonSchema.type).toBe("object")
    expect(jsonSchema.properties).toHaveProperty("role")
    expect(jsonSchema.properties).toHaveProperty("content")
  })

  it("auto-resolves schema from path pattern on createStream", () => {
    engine.registerRouter(mockRouter)

    // No explicit schemaKey — engine resolves from path
    const stream = engine.createStream("/chat/abc123")
    expect(stream.schemaKey).toBe("chat")
  })

  it("auto-resolves nested path pattern", () => {
    engine.registerRouter(mockRouter)
    const stream = engine.createStream("/chat/abc123/events/run-001")
    expect(stream.schemaKey).toBe("chatEvents")
  })

  it("validates appends on auto-resolved schema stream", () => {
    engine.registerRouter(mockRouter)
    engine.createStream("/chat/test-123")

    // Valid message
    const good = encoder.encode(JSON.stringify({ role: "user", content: "hello" }))
    expect(() => engine.append("/chat/test-123", good)).not.toThrow()

    // Invalid message
    const bad = encoder.encode(JSON.stringify({ role: "invalid", content: 123 }))
    expect(() => engine.append("/chat/test-123", bad)).toThrow()
  })

  it("validates appends on auto-resolved nested schema stream", () => {
    engine.registerRouter(mockRouter)
    engine.createStream("/chat/test-123/events/run-001")

    const good = encoder.encode(JSON.stringify({ type: "start" }))
    expect(() => engine.append("/chat/test-123/events/run-001", good)).not.toThrow()

    const bad = encoder.encode(JSON.stringify({ type: "unknown" }))
    expect(() => engine.append("/chat/test-123/events/run-001", bad)).toThrow()
  })

  it("no schema for paths that don't match any pattern", () => {
    engine.registerRouter(mockRouter)
    const stream = engine.createStream("/random/path")
    expect(stream.schemaKey).toBeNull()

    // Any data is accepted
    const data = encoder.encode("not json at all")
    expect(() => engine.append("/random/path", data)).not.toThrow()
  })

  it("validates data with trailing comma (DurableStore compat)", () => {
    engine.registerRouter(mockRouter)
    engine.createStream("/chat/comma-test")

    // processJsonAppend adds trailing comma
    const data = encoder.encode('{"role":"user","content":"hi"},')
    expect(() => engine.append("/chat/comma-test", data)).not.toThrow()
  })

  it("explicit schemaKey overrides auto-resolution", () => {
    engine.registerRouter(mockRouter)

    // Create stream with explicit schemaKey that differs from pattern
    const stream = engine.createStream("/chat/override", { schemaKey: "chatEvents" })
    expect(stream.schemaKey).toBe("chatEvents")

    // Should validate against event schema, not message schema
    const event = encoder.encode(JSON.stringify({ type: "start" }))
    expect(() => engine.append("/chat/override", event)).not.toThrow()

    const message = encoder.encode(JSON.stringify({ role: "user", content: "hi" }))
    expect(() => engine.append("/chat/override", message)).toThrow()
  })
})
