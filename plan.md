# Refactor: SQLite Source of Truth + JSONL Audit Trail

## Summary

Replace the hybrid JSONL-indexed-by-SQLite system with:
- **SQLite** as the sole source of truth (events, sessions, outbox, jobs)
- **JSONL** as a dumb, typed, daily-rotated audit log (analytics/forensics only)

## New SQLite Schema

### `sessions` — tracks each conversation

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- ULID
  created_at  INTEGER NOT NULL,          -- epoch ms
  updated_at  INTEGER NOT NULL,          -- epoch ms
  current_seq INTEGER NOT NULL DEFAULT 0 -- per-session monotonic counter
);
```

### `events` — append-only, the core of the system

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,           -- per-session sequence (for cursor-based reads)
  type        TEXT NOT NULL,              -- discriminator (see below)
  payload     TEXT NOT NULL,              -- JSON blob, full event data
  created_at  INTEGER NOT NULL            -- epoch ms
);

CREATE UNIQUE INDEX idx_events_session_seq ON events(session_id, seq);
CREATE INDEX idx_events_session_type ON events(session_id, type);
```

Event types (discriminated via `type` column):
- `user_message` — inbound user message
- `assistant_start` — LLM generation started
- `assistant_delta` — streaming token/chunk
- `assistant_final` — completed assistant message
- `tool_call` — agent invoked a tool
- `tool_result` — tool returned a result
- `agent_start` / `agent_end` — run lifecycle
- `turn_start` / `turn_end` — turn lifecycle
- `error` — something went wrong

Conversation history for agent context = `WHERE type IN ('user_message', 'assistant_final', 'tool_result')`.
Full replay = `WHERE session_id = ? AND seq > ? ORDER BY seq`.

### `outbox` — transactional outbox (drained inline for now)

```sql
CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,              -- denormalized for routing
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_outbox_pending ON outbox(status) WHERE status = 'pending';
```

Written in the same tx as the event. After tx commits, drain inline (call SSE listeners). Failed deliveries stay for retry. Future: background worker for WA/TG channels.

### `jobs` — durable queue for agent work

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,          -- ULID
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,             -- 'agent_prompt', etc.
  payload      TEXT NOT NULL,             -- JSON
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | completed | failed
  claimed_at   INTEGER,
  completed_at INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_jobs_pending ON jobs(status, created_at) WHERE status = 'pending';
```

Single worker claims a job, processes it, marks complete. For now, agent prompts only.

## JSONL Audit Logger

Daily-rotated, typed, fire-and-forget. Not read by the app.

```
DATA_DIR/
├── ellie.db              -- SQLite (renamed from streams.db)
├── ellie.db-wal
└── audit/
    ├── 2026-02-24.jsonl
    ├── 2026-02-25.jsonl
    └── ...
```

Each line is a validated JSON object with `ts`, `type`, `session_id`, and full payload. Valibot-validated on write — bad data is caught and logged to stderr, never written.

```ts
// Example audit line:
{"ts":1740000000000,"type":"assistant_final","session_id":"01HQ...","payload":{...}}
```

New class: `AuditLogger`
- Constructor takes `logDir: string`
- `log(entry: AuditEntry): void` — validate, serialize, append. Swallows errors.
- Internally uses `LogFile`, rotates daily by filename.
- No reads, no indexing, no SQLite.

## New Core Class: `EventStore`

Replaces `JsonlEngine` + `TypedLog` as the single interface to SQLite.

```ts
class EventStore {
  constructor(dbPath: string, auditLogDir: string)

  // Sessions
  createSession(id?: string): Session
  getSession(id: string): Session | undefined
  listSessions(): Session[]
  deleteSession(id: string): void  // hard delete, cascades

  // Events (append-only)
  append(sessionId: string, type: EventType, payload: object): EventRow
  // ^^ Atomically: insert event + bump session.current_seq + insert outbox row + audit log

  query(sessionId: string, opts?: {
    after?: number        // seq-based cursor (exclusive)
    types?: EventType[]   // filter by type(s)
    limit?: number
  }): EventRow[]

  // Convenience: get conversation history for agent context
  getConversationHistory(sessionId: string): EventRow[]
  // = query(sessionId, { types: ['user_message', 'assistant_final', 'tool_result'] })

  // Outbox (inline drain)
  drainOutbox(sessionId: string, deliver: (event: EventRow) => boolean): void

  // Jobs
  enqueue(sessionId: string, type: string, payload: object): string  // returns job id
  claim(): JobRow | undefined   // claim oldest pending job
  complete(jobId: string): void
  fail(jobId: string, error: string): void

  close(): void
}
```

## Files Changed

### Delete entirely
- `packages/db/src/jsonl-store.ts` — JsonlEngine (replaced by EventStore)
- `packages/db/src/typed-log.ts` — TypedLog (no longer needed)
- `packages/db/drizzle/0000_sleepy_mac_gargan.sql` — old migration
- `packages/db/drizzle/0001_brainy_quasimodo.sql` — old migration
- `packages/db/drizzle/meta/*` — old migration metadata

### New files
- `packages/db/src/schema.ts` — rewrite: sessions, events, outbox, jobs tables
- `packages/db/src/event-store.ts` — new EventStore class
- `packages/db/src/audit-log.ts` — new AuditLogger class
- `packages/db/drizzle/0000_initial.sql` — fresh migration for new schema
- `packages/db/src/db.test.ts` — rewrite tests for new system

### Rewrite
- `packages/db/src/index.ts` — new exports (EventStore, AuditLogger, drop JsonlEngine/TypedLog)
- `apps/app/src/lib/realtime-store.ts` — backed by EventStore, pub/sub stays in-memory, audit log on every write
- `apps/app/src/server.ts` — init EventStore instead of JsonlEngine
- `apps/app/src/agent/manager.ts` — update `AgentPersistenceStore` interface, wire to EventStore-backed store
- `apps/app/src/routes/chat.ts` — minor: read from store (API stays similar)
- `apps/app/src/routes/agent.ts` — minor: read from store, SSE catch-up uses seq cursor
- `apps/app/src/agent/manager.test.ts` — update mock to new interface

### Keep as-is
- `packages/db/src/log.ts` — LogFile, reused by AuditLogger
- `packages/db/src/init.ts` — SQLiteManager, unchanged
- `packages/schemas/src/*` — Valibot schemas stay, may add audit entry schema
- `packages/agent/src/*` — Agent types unchanged

## Implementation Order

### Step 1: New schema + migrations
Write new Drizzle schema (`sessions`, `events`, `outbox`, `jobs`). Generate fresh migration. Drop all old migration files.

### Step 2: AuditLogger
Build `AuditLogger` class on top of `LogFile`. Daily rotation, Valibot-typed entries, fire-and-forget writes.

### Step 3: EventStore
Build `EventStore` — append, query, conversation history, outbox drain, job queue. All backed by new SQLite tables. Every `append` also writes to `AuditLogger`.

### Step 4: Rewire RealtimeStore
Rewrite `RealtimeStore` to use `EventStore` instead of `JsonlEngine`/`typedLog`. Keep the same public API shape where possible so routes need minimal changes. In-memory pub/sub stays.

### Step 5: Rewire server + routes + AgentManager
- `server.ts`: init `EventStore` instead of `JsonlEngine`
- Routes: update to use seq-based cursors for SSE catch-up
- `AgentManager`: update interface, wire to new store

### Step 6: Cleanup
Delete `jsonl-store.ts`, `typed-log.ts`, old migrations, old test code. Update `packages/db/src/index.ts` exports. Rewrite tests.

### Step 7: Verify
Run `bun run check-types`, `bun run test`, `bun run build`. Fix any breakage.
