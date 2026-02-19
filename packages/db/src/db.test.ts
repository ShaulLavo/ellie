import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createDB, isVecAvailable } from "./index"
import { eq, and, like, sql } from "drizzle-orm"
import { existsSync, unlinkSync } from "fs"
import type { Database } from "bun:sqlite"

const TEST_DB_PATH = "/tmp/ellie-db-test.db"

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix)
    } catch {}
  }
}

describe("@ellie/db", () => {
  let db: ReturnType<typeof createDB>["db"]
  let sqlite: Database
  let schema: ReturnType<typeof createDB>["schema"]

  beforeEach(() => {
    cleanup()
    const result = createDB(TEST_DB_PATH)
    db = result.db
    sqlite = result.sqlite
    schema = result.schema
  })

  afterEach(() => {
    sqlite.close()
    cleanup()
  })

  // ── Database initialization ──────────────────────────────────────────────

  describe("initialization", () => {
    it("creates the database file", () => {
      expect(existsSync(TEST_DB_PATH)).toBe(true)
    })

    it("creates all expected tables", () => {
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]

      const tableNames = tables.map((t) => t.name)
      expect(tableNames).toContain("streams")
      expect(tableNames).toContain("messages")
      expect(tableNames).toContain("producers")
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

    it("is idempotent — calling createDB twice on same path works", () => {
      sqlite.close()
      const result = createDB(TEST_DB_PATH)
      const tables = result.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as { name: string }[]
      expect(tables.map((t) => t.name)).toContain("streams")
      result.sqlite.close()
    })
  })

  // ── Streams CRUD ─────────────────────────────────────────────────────────

  describe("streams", () => {
    it("inserts and reads a stream", () => {
      const now = Date.now()
      db.insert(schema.streams)
        .values({
          path: "/chat/session-1",
          contentType: "application/json",
          createdAt: now,
        })
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/chat/session-1"))
        .get()

      expect(stream).toBeDefined()
      expect(stream!.path).toBe("/chat/session-1")
      expect(stream!.contentType).toBe("application/json")
      expect(stream!.createdAt).toBe(now)
      expect(stream!.closed).toBe(false)
      expect(stream!.currentReadSeq).toBe(0)
      expect(stream!.currentByteOffset).toBe(0)
    })

    it("inserts stream with TTL and expiry", () => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString()
      db.insert(schema.streams)
        .values({
          path: "/ephemeral",
          createdAt: Date.now(),
          ttlSeconds: 3600,
          expiresAt,
        })
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/ephemeral"))
        .get()

      expect(stream!.ttlSeconds).toBe(3600)
      expect(stream!.expiresAt).toBe(expiresAt)
    })

    it("updates stream closed state with closedBy info", () => {
      db.insert(schema.streams)
        .values({ path: "/closable", createdAt: Date.now() })
        .run()

      db.update(schema.streams)
        .set({
          closed: true,
          closedByProducerId: "producer-xyz",
          closedByEpoch: 2,
          closedBySeq: 5,
        })
        .where(eq(schema.streams.path, "/closable"))
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/closable"))
        .get()

      expect(stream!.closed).toBe(true)
      expect(stream!.closedByProducerId).toBe("producer-xyz")
      expect(stream!.closedByEpoch).toBe(2)
      expect(stream!.closedBySeq).toBe(5)
    })

    it("updates currentOffset fields", () => {
      db.insert(schema.streams)
        .values({ path: "/offset-test", createdAt: Date.now() })
        .run()

      db.update(schema.streams)
        .set({ currentReadSeq: 10, currentByteOffset: 4096 })
        .where(eq(schema.streams.path, "/offset-test"))
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/offset-test"))
        .get()

      expect(stream!.currentReadSeq).toBe(10)
      expect(stream!.currentByteOffset).toBe(4096)
    })

    it("deletes a stream", () => {
      db.insert(schema.streams)
        .values({ path: "/deleteme", createdAt: Date.now() })
        .run()

      db.delete(schema.streams)
        .where(eq(schema.streams.path, "/deleteme"))
        .run()

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/deleteme"))
        .get()

      expect(stream).toBeUndefined()
    })

    it("lists all streams", () => {
      db.insert(schema.streams)
        .values([
          { path: "/a", createdAt: Date.now() },
          { path: "/b", createdAt: Date.now() },
          { path: "/c", createdAt: Date.now() },
        ])
        .run()

      const all = db.select().from(schema.streams).all()
      expect(all).toHaveLength(3)
    })

    it("enforces unique path constraint", () => {
      db.insert(schema.streams)
        .values({ path: "/unique", createdAt: Date.now() })
        .run()

      expect(() => {
        db.insert(schema.streams)
          .values({ path: "/unique", createdAt: Date.now() })
          .run()
      }).toThrow()
    })
  })

  // ── Messages CRUD ────────────────────────────────────────────────────────

  describe("messages", () => {
    beforeEach(() => {
      db.insert(schema.streams)
        .values({
          path: "/test-stream",
          contentType: "application/json",
          createdAt: Date.now(),
        })
        .run()
    })

    it("inserts and reads a message with blob data", () => {
      const payload = JSON.stringify({ role: "user", content: "hello" })
      const data = Buffer.from(payload)

      db.insert(schema.messages)
        .values({
          streamPath: "/test-stream",
          data,
          offset: "0000000000000000_0000000000000042",
          timestamp: Date.now(),
        })
        .run()

      const msgs = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, "/test-stream"))
        .all()

      expect(msgs).toHaveLength(1)
      expect(Buffer.from(msgs[0]!.data).toString()).toBe(payload)
      expect(msgs[0]!.offset).toBe("0000000000000000_0000000000000042")
    })

    it("inserts multiple messages and reads in offset order", () => {
      const offsets = [
        "0000000000000000_0000000000000010",
        "0000000000000000_0000000000000020",
        "0000000000000000_0000000000000030",
        "0000000000000000_0000000000000040",
        "0000000000000000_0000000000000050",
      ]

      for (const offset of offsets) {
        db.insert(schema.messages)
          .values({
            streamPath: "/test-stream",
            data: Buffer.from(`msg-${offset}`),
            offset,
            timestamp: Date.now(),
          })
          .run()
      }

      const msgs = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, "/test-stream"))
        .orderBy(schema.messages.offset)
        .all()

      expect(msgs).toHaveLength(5)
      expect(msgs.map((m) => m.offset)).toEqual(offsets)
    })

    it("reads messages after a given offset (range query)", () => {
      for (let i = 1; i <= 10; i++) {
        const offset = `0000000000000000_${String(i * 100).padStart(16, "0")}`
        db.insert(schema.messages)
          .values({
            streamPath: "/test-stream",
            data: Buffer.from(`msg-${i}`),
            offset,
            timestamp: Date.now(),
          })
          .run()
      }

      // Read messages after offset 500
      const afterOffset = "0000000000000000_0000000000000500"
      const msgs = db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.streamPath, "/test-stream"),
            sql`${schema.messages.offset} > ${afterOffset}`
          )
        )
        .orderBy(schema.messages.offset)
        .all()

      expect(msgs).toHaveLength(5)
      expect(Buffer.from(msgs[0]!.data).toString()).toBe("msg-6")
    })

    it("handles binary data correctly", () => {
      const binaryData = new Uint8Array([0x00, 0xff, 0x42, 0xde, 0xad, 0xbe, 0xef])

      db.insert(schema.messages)
        .values({
          streamPath: "/test-stream",
          data: Buffer.from(binaryData),
          offset: "0000000000000000_0000000000000007",
          timestamp: Date.now(),
        })
        .run()

      const msg = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, "/test-stream"))
        .get()

      const retrieved = new Uint8Array(msg!.data as ArrayBuffer)
      expect(retrieved).toEqual(binaryData)
    })

    it("autoincrement IDs are sequential", () => {
      for (let i = 0; i < 3; i++) {
        db.insert(schema.messages)
          .values({
            streamPath: "/test-stream",
            data: Buffer.from(`msg-${i}`),
            offset: `0000000000000000_${String(i * 10).padStart(16, "0")}`,
            timestamp: Date.now(),
          })
          .run()
      }

      const msgs = db
        .select()
        .from(schema.messages)
        .orderBy(schema.messages.id)
        .all()

      expect(msgs[0]!.id).toBe(1)
      expect(msgs[1]!.id).toBe(2)
      expect(msgs[2]!.id).toBe(3)
    })
  })

  // ── Producers CRUD ───────────────────────────────────────────────────────

  describe("producers", () => {
    beforeEach(() => {
      db.insert(schema.streams)
        .values({ path: "/prod-stream", createdAt: Date.now() })
        .run()
    })

    it("inserts and reads producer state", () => {
      const now = Date.now()
      db.insert(schema.producers)
        .values({
          streamPath: "/prod-stream",
          producerId: "producer-abc",
          epoch: 0,
          lastSeq: 5,
          lastUpdated: now,
        })
        .run()

      const prod = db
        .select()
        .from(schema.producers)
        .where(
          and(
            eq(schema.producers.streamPath, "/prod-stream"),
            eq(schema.producers.producerId, "producer-abc")
          )
        )
        .get()

      expect(prod).toBeDefined()
      expect(prod!.epoch).toBe(0)
      expect(prod!.lastSeq).toBe(5)
      expect(prod!.lastUpdated).toBe(now)
    })

    it("supports multiple producers per stream", () => {
      const now = Date.now()
      db.insert(schema.producers)
        .values([
          {
            streamPath: "/prod-stream",
            producerId: "producer-a",
            epoch: 0,
            lastSeq: 3,
            lastUpdated: now,
          },
          {
            streamPath: "/prod-stream",
            producerId: "producer-b",
            epoch: 1,
            lastSeq: 7,
            lastUpdated: now,
          },
        ])
        .run()

      const prods = db
        .select()
        .from(schema.producers)
        .where(eq(schema.producers.streamPath, "/prod-stream"))
        .all()

      expect(prods).toHaveLength(2)
    })

    it("updates producer state (epoch bump)", () => {
      const now = Date.now()
      db.insert(schema.producers)
        .values({
          streamPath: "/prod-stream",
          producerId: "producer-abc",
          epoch: 0,
          lastSeq: 10,
          lastUpdated: now,
        })
        .run()

      // Bump epoch, reset seq
      db.update(schema.producers)
        .set({ epoch: 1, lastSeq: 0, lastUpdated: Date.now() })
        .where(
          and(
            eq(schema.producers.streamPath, "/prod-stream"),
            eq(schema.producers.producerId, "producer-abc")
          )
        )
        .run()

      const prod = db
        .select()
        .from(schema.producers)
        .where(eq(schema.producers.producerId, "producer-abc"))
        .get()

      expect(prod!.epoch).toBe(1)
      expect(prod!.lastSeq).toBe(0)
    })

    it("enforces unique (streamPath, producerId) constraint", () => {
      db.insert(schema.producers)
        .values({
          streamPath: "/prod-stream",
          producerId: "dup-producer",
          epoch: 0,
          lastSeq: 0,
          lastUpdated: Date.now(),
        })
        .run()

      expect(() => {
        db.insert(schema.producers)
          .values({
            streamPath: "/prod-stream",
            producerId: "dup-producer",
            epoch: 0,
            lastSeq: 1,
            lastUpdated: Date.now(),
          })
          .run()
      }).toThrow()
    })
  })

  // ── Cascade deletes ──────────────────────────────────────────────────────

  describe("cascade deletes", () => {
    it("deleting a stream cascades to messages and producers", () => {
      const now = Date.now()

      db.insert(schema.streams)
        .values({ path: "/cascade-test", createdAt: now })
        .run()

      // Insert messages
      for (let i = 0; i < 5; i++) {
        db.insert(schema.messages)
          .values({
            streamPath: "/cascade-test",
            data: Buffer.from(`msg-${i}`),
            offset: `0000000000000000_${String(i * 10).padStart(16, "0")}`,
            timestamp: now,
          })
          .run()
      }

      // Insert producers
      db.insert(schema.producers)
        .values({
          streamPath: "/cascade-test",
          producerId: "p1",
          epoch: 0,
          lastSeq: 4,
          lastUpdated: now,
        })
        .run()

      // Verify they exist
      expect(
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.streamPath, "/cascade-test"))
          .all()
      ).toHaveLength(5)
      expect(
        db
          .select()
          .from(schema.producers)
          .where(eq(schema.producers.streamPath, "/cascade-test"))
          .all()
      ).toHaveLength(1)

      // Delete stream
      db.delete(schema.streams)
        .where(eq(schema.streams.path, "/cascade-test"))
        .run()

      // Verify cascade
      expect(
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.streamPath, "/cascade-test"))
          .all()
      ).toHaveLength(0)
      expect(
        db
          .select()
          .from(schema.producers)
          .where(eq(schema.producers.streamPath, "/cascade-test"))
          .all()
      ).toHaveLength(0)
    })
  })

  // ── Transactions ─────────────────────────────────────────────────────────

  describe("transactions", () => {
    it("supports atomic append (stream update + message insert)", () => {
      db.insert(schema.streams)
        .values({
          path: "/txn-stream",
          contentType: "application/json",
          createdAt: Date.now(),
        })
        .run()

      const payload = JSON.stringify({ event: "click" })
      const data = Buffer.from(payload)
      const newByteOffset = data.length

      // Atomic: insert message + update stream offset
      sqlite.run("BEGIN")
      try {
        db.insert(schema.messages)
          .values({
            streamPath: "/txn-stream",
            data,
            offset: `0000000000000000_${String(newByteOffset).padStart(16, "0")}`,
            timestamp: Date.now(),
          })
          .run()

        db.update(schema.streams)
          .set({ currentByteOffset: newByteOffset })
          .where(eq(schema.streams.path, "/txn-stream"))
          .run()

        sqlite.run("COMMIT")
      } catch (e) {
        sqlite.run("ROLLBACK")
        throw e
      }

      const stream = db
        .select()
        .from(schema.streams)
        .where(eq(schema.streams.path, "/txn-stream"))
        .get()
      expect(stream!.currentByteOffset).toBe(newByteOffset)

      const msgs = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, "/txn-stream"))
        .all()
      expect(msgs).toHaveLength(1)
    })
  })

  // ── sqlite-vec (vector operations) ───────────────────────────────────────

  describe("sqlite-vec", () => {
    it("vec_version() returns a version string", () => {
      const result = sqlite.prepare("SELECT vec_version() as v").get() as {
        v: string
      }
      expect(result.v).toMatch(/^v\d+\.\d+\.\d+/)
    })

    it("isVecAvailable() returns true", () => {
      expect(isVecAvailable()).toBe(true)
    })

    it("creates a vec0 virtual table", () => {
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS test_vectors
        USING vec0(id TEXT PRIMARY KEY, embedding float[4])
      `)

      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='test_vectors'"
        )
        .all() as { name: string }[]
      expect(tables).toHaveLength(1)
    })

    it("inserts and retrieves vectors", () => {
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS embed_test
        USING vec0(id TEXT PRIMARY KEY, embedding float[3])
      `)

      const insert = sqlite.prepare(
        "INSERT INTO embed_test (id, embedding) VALUES (?, ?)"
      )
      insert.run("vec-1", new Float32Array([1.0, 0.0, 0.0]))
      insert.run("vec-2", new Float32Array([0.0, 1.0, 0.0]))
      insert.run("vec-3", new Float32Array([0.0, 0.0, 1.0]))

      const count = sqlite
        .prepare("SELECT count(*) as c FROM embed_test")
        .get() as { c: number }
      expect(count.c).toBe(3)
    })

    it("performs KNN cosine similarity search", () => {
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knn_test
        USING vec0(id TEXT PRIMARY KEY, embedding float[3])
      `)

      const insert = sqlite.prepare(
        "INSERT INTO knn_test (id, embedding) VALUES (?, ?)"
      )
      insert.run("north", new Float32Array([0.0, 1.0, 0.0]))
      insert.run("east", new Float32Array([1.0, 0.0, 0.0]))
      insert.run("northeast", new Float32Array([0.707, 0.707, 0.0]))
      insert.run("south", new Float32Array([0.0, -1.0, 0.0]))

      // Search for vectors closest to "north" (0, 1, 0)
      const query = new Float32Array([0.0, 1.0, 0.0])
      const results = sqlite
        .prepare(
          `
          SELECT id, vec_distance_cosine(embedding, ?) as distance
          FROM knn_test
          WHERE embedding MATCH ?
          AND k = 3
          ORDER BY distance ASC
        `
        )
        .all(query, query) as { id: string; distance: number }[]

      expect(results).toHaveLength(3)
      // Closest should be "north" itself (distance ~0)
      expect(results[0]!.id).toBe("north")
      expect(results[0]!.distance).toBeCloseTo(0, 4)
      // Second should be "northeast"
      expect(results[1]!.id).toBe("northeast")
      // "south" should be furthest (opposite direction)
      expect(results[2]!.id).not.toBe("south") // south shouldn't be in top 3 closest
    })

    it("performs KNN search with L2 distance", () => {
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l2_test
        USING vec0(id TEXT PRIMARY KEY, embedding float[2])
      `)

      const insert = sqlite.prepare(
        "INSERT INTO l2_test (id, embedding) VALUES (?, ?)"
      )
      insert.run("origin", new Float32Array([0.0, 0.0]))
      insert.run("close", new Float32Array([1.0, 1.0]))
      insert.run("far", new Float32Array([10.0, 10.0]))

      const query = new Float32Array([0.0, 0.0])
      const results = sqlite
        .prepare(
          `
          SELECT id, distance
          FROM l2_test
          WHERE embedding MATCH ?
          AND k = 3
          ORDER BY distance ASC
        `
        )
        .all(query) as { id: string; distance: number }[]

      expect(results[0]!.id).toBe("origin")
      expect(results[0]!.distance).toBeCloseTo(0)
      expect(results[1]!.id).toBe("close")
      expect(results[2]!.id).toBe("far")
    })

    it("joins vec table with regular Drizzle table", () => {
      // Create a regular table for metadata
      db.insert(schema.streams)
        .values([
          { path: "/chat/a", contentType: "application/json", createdAt: Date.now() },
          { path: "/chat/b", contentType: "application/json", createdAt: Date.now() },
          { path: "/chat/c", contentType: "text/plain", createdAt: Date.now() },
        ])
        .run()

      // Create vec table for stream embeddings
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS stream_embeddings
        USING vec0(path TEXT PRIMARY KEY, embedding float[3])
      `)

      const insert = sqlite.prepare(
        "INSERT INTO stream_embeddings (path, embedding) VALUES (?, ?)"
      )
      insert.run("/chat/a", new Float32Array([1.0, 0.0, 0.0]))
      insert.run("/chat/b", new Float32Array([0.9, 0.1, 0.0]))
      insert.run("/chat/c", new Float32Array([0.0, 0.0, 1.0]))

      // Join: find streams closest to [1, 0, 0] with their metadata
      const query = new Float32Array([1.0, 0.0, 0.0])
      const results = sqlite
        .prepare(
          `
          SELECT s.path, s.content_type, vec_distance_cosine(e.embedding, ?) as distance
          FROM stream_embeddings e
          JOIN streams s ON s.path = e.path
          WHERE e.embedding MATCH ?
          AND k = 2
          ORDER BY distance ASC
        `
        )
        .all(query, query) as {
        path: string
        content_type: string
        distance: number
      }[]

      expect(results).toHaveLength(2)
      expect(results[0]!.path).toBe("/chat/a")
      expect(results[0]!.content_type).toBe("application/json")
      expect(results[0]!.distance).toBeCloseTo(0, 4)
    })
  })

  // ── FTS5 (full-text search) ──────────────────────────────────────────────

  describe("FTS5", () => {
    beforeEach(() => {
      // Create FTS5 virtual table for full-text search on stream content
      sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(stream_path, content, tokenize='porter')
      `)
    })

    it("FTS5 is available", () => {
      // If the CREATE VIRTUAL TABLE above succeeded, FTS5 is compiled in
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='messages_fts'"
        )
        .all() as { name: string }[]
      expect(tables).toHaveLength(1)
    })

    it("inserts and searches text content", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/chat/1", "The quick brown fox jumps over the lazy dog")
      insert.run("/chat/1", "TypeScript is a typed superset of JavaScript")
      insert.run("/chat/2", "SQLite is a self-contained database engine")
      insert.run("/chat/2", "The fox was very quick indeed")

      const results = sqlite
        .prepare(
          "SELECT stream_path, content FROM messages_fts WHERE messages_fts MATCH 'fox'"
        )
        .all() as { stream_path: string; content: string }[]

      expect(results).toHaveLength(2)
      expect(results.every((r) => r.content.toLowerCase().includes("fox"))).toBe(true)
    })

    it("supports phrase queries", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/doc/1", "the durable streams protocol is append only")
      insert.run("/doc/2", "append operations are fast and durable")
      insert.run("/doc/3", "streaming data in real time")

      const results = sqlite
        .prepare(
          `SELECT content FROM messages_fts WHERE messages_fts MATCH '"durable streams"'`
        )
        .all() as { content: string }[]

      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain("durable streams")
    })

    it("supports porter stemming (running matches run)", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/chat/1", "I was running through the park")
      insert.run("/chat/2", "She runs every morning")
      insert.run("/chat/3", "The connection is working fine")
      insert.run("/chat/4", "SQLite is fast")

      // "run" should match "running" and "runs" via porter stemmer
      const results = sqlite
        .prepare(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'run'"
        )
        .all() as { content: string }[]

      expect(results).toHaveLength(2)
      expect(results.some((r) => r.content.includes("running"))).toBe(true)
      expect(results.some((r) => r.content.includes("runs"))).toBe(true)
    })

    it("supports prefix queries", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/chat/1", "database operations are important")
      insert.run("/chat/2", "data structures in computer science")
      insert.run("/chat/3", "the cat sat on the mat")

      const results = sqlite
        .prepare(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'dat*'"
        )
        .all() as { content: string }[]

      expect(results).toHaveLength(2)
    })

    it("supports boolean operators (AND, OR, NOT)", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/chat/1", "SQLite database engine with FTS5")
      insert.run("/chat/2", "PostgreSQL database server")
      insert.run("/chat/3", "Redis cache server")
      insert.run("/chat/4", "SQLite is lightweight")

      // AND
      const andResults = sqlite
        .prepare(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'SQLite AND database'"
        )
        .all() as { content: string }[]
      expect(andResults).toHaveLength(1)
      expect(andResults[0]!.content).toContain("SQLite database")

      // OR
      const orResults = sqlite
        .prepare(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'SQLite OR Redis'"
        )
        .all() as { content: string }[]
      expect(orResults).toHaveLength(3)

      // NOT
      const notResults = sqlite
        .prepare(
          "SELECT content FROM messages_fts WHERE messages_fts MATCH 'database NOT PostgreSQL'"
        )
        .all() as { content: string }[]
      expect(notResults).toHaveLength(1)
      expect(notResults[0]!.content).toContain("SQLite")
    })

    it("supports BM25 ranking", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      // Doc with "sqlite" mentioned multiple times should rank higher
      insert.run("/chat/1", "SQLite SQLite SQLite is the best database")
      insert.run("/chat/2", "SQLite is a database")
      insert.run("/chat/3", "No mention of that database here")

      const results = sqlite
        .prepare(
          `
          SELECT content, bm25(messages_fts) as rank
          FROM messages_fts
          WHERE messages_fts MATCH 'SQLite'
          ORDER BY rank
        `
        )
        .all() as { content: string; rank: number }[]

      expect(results).toHaveLength(2)
      // BM25 returns negative values, more negative = better match
      expect(results[0]!.rank).toBeLessThan(results[1]!.rank)
    })

    it("supports highlight() and snippet() functions", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run(
        "/doc/1",
        "The durable streams protocol provides append-only log semantics for distributed systems"
      )

      const highlighted = sqlite
        .prepare(
          `
          SELECT highlight(messages_fts, 1, '<b>', '</b>') as h
          FROM messages_fts
          WHERE messages_fts MATCH 'durable'
        `
        )
        .get() as { h: string }

      expect(highlighted.h).toContain("<b>")
      expect(highlighted.h).toContain("</b>")

      const snippet = sqlite
        .prepare(
          `
          SELECT snippet(messages_fts, 1, '<b>', '</b>', '...', 10) as s
          FROM messages_fts
          WHERE messages_fts MATCH 'append'
        `
        )
        .get() as { s: string }

      expect(snippet.s).toContain("<b>")
    })

    it("filters FTS results by stream_path", () => {
      const insert = sqlite.prepare(
        "INSERT INTO messages_fts (stream_path, content) VALUES (?, ?)"
      )
      insert.run("/chat/1", "hello world from stream one")
      insert.run("/chat/2", "hello world from stream two")
      insert.run("/chat/3", "hello world from stream three")

      const results = sqlite
        .prepare(
          `
          SELECT stream_path, content
          FROM messages_fts
          WHERE messages_fts MATCH 'hello'
          AND stream_path = '/chat/2'
        `
        )
        .all() as { stream_path: string; content: string }[]

      expect(results).toHaveLength(1)
      expect(results[0]!.stream_path).toBe("/chat/2")
    })
  })

  // ── Performance / bulk operations ────────────────────────────────────────

  describe("bulk operations", () => {
    it("batch inserts 1000 messages efficiently", () => {
      db.insert(schema.streams)
        .values({ path: "/bulk", createdAt: Date.now() })
        .run()

      const start = performance.now()

      const insertMsg = sqlite.prepare(
        "INSERT INTO messages (stream_path, data, offset, timestamp) VALUES (?, ?, ?, ?)"
      )

      const batchInsert = sqlite.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          const offset = `0000000000000000_${String(i * 50).padStart(16, "0")}`
          insertMsg.run(
            "/bulk",
            Buffer.from(JSON.stringify({ i, event: "test" })),
            offset,
            Date.now()
          )
        }
      })

      batchInsert()

      const elapsed = performance.now() - start

      const count = sqlite
        .prepare("SELECT count(*) as c FROM messages WHERE stream_path = '/bulk'")
        .get() as { c: number }

      expect(count.c).toBe(1000)
      // Should complete in under 1 second (WAL mode + transaction batching)
      expect(elapsed).toBeLessThan(1000)
    })
  })
})
