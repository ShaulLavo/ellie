# Database Layer

Hybrid storage: SQLite for metadata/indexes, JSONL files for message data. Drizzle ORM over Bun SQLite.

## SQLite Schema (Drizzle)

Three tables defined in `packages/db/src/schema.ts`:

### `streams`
| Column | Type | Notes |
|--------|------|-------|
| `path` (PK) | text | e.g., `/chat/session-1` |
| `content_type` | text | e.g., `application/json` |
| `ttl_seconds` | integer | relative TTL |
| `expires_at` | text | ISO-8601 absolute expiry |
| `created_at` | integer | milliseconds |
| `deleted_at` | integer | nullable, soft-delete flag |
| `closed` | integer | boolean, default false |
| `closed_by_producer_id` | text | nullable |
| `closed_by_epoch` | integer | nullable |
| `closed_by_seq` | integer | nullable |
| `current_read_seq` | integer | generation counter, default 0 |
| `current_byte_offset` | integer | cumulative JSONL byte offset |

### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` (PK) | integer | auto-increment |
| `stream_path` (FK) | text | cascading delete to streams |
| `byte_pos` | integer | position in JSONL file |
| `length` | integer | byte length of data |
| `offset` | text | formatted offset string |
| `timestamp` | integer | milliseconds |

Index: `idx_messages_stream_offset` on `(stream_path, offset)`.

Messages table stores **pointers only** — actual data is in the JSONL file.

### `producers`
| Column | Type | Notes |
|--------|------|-------|
| `stream_path` (PK) | text | FK to streams, cascading delete |
| `producer_id` (PK) | text | composite PK with stream_path |
| `epoch` | integer | generation counter |
| `last_seq` | integer | highest sequence seen |
| `last_updated` | integer | milliseconds, for TTL cleanup (7 days) |

## JSONL Storage

**File**: `packages/db/src/log.ts` — `LogFile` class.

Each stream gets one `.jsonl` file. Path conversion: `/chat/session-1` → `chat__session-1.jsonl` (see `streamPathToFilename()`).

**Append**: two `writeSync()` calls (data + newline). Returns `{bytePos, length}`.

**Read**: positioned reads via `readAt(bytePos, length)` or `readRange(entries)`. No seeking needed.

**On-disk layout:**
```
DATA_DIR/
├── streams.db          # SQLite
├── streams.db-wal
└── logs/
    ├── chat__session-1.jsonl
    └── chat__session-2.jsonl
```

## JsonlEngine

**File**: `packages/db/src/jsonl-store.ts` — bridges SQLite + JSONL.

### Append (two-phase)
1. Write data to JSONL via `LogFile.append()` → get `{bytePos, length}`
2. Atomic SQLite transaction: insert message index row + update stream's `current_byte_offset`

### Read
1. Query SQLite index for message rows (optionally `WHERE offset > afterOffset`)
2. Read data from JSONL using stored `(bytePos, length)` pairs
3. Returns `JsonlMessage[]` — `{data: Uint8Array, offset: string, timestamp: number}`

### Offset Format
`formatOffset(readSeq, byteOffset)` → `"0000000000000000_0000000000000042"` — 16-digit zero-padded, lexicographically sortable.

### Stream Resurrection
On recreate after soft-delete: increments `currentReadSeq` (invalidates old offsets), resets `currentByteOffset` to 0, clears old messages/producers. JSONL file persists on disk.

### Other Methods
- `createStream(path, options)` — idempotent, handles resurrection
- `getStream(path)` — filters out soft-deleted
- `deleteStream(path)` — soft-delete, closes file descriptor
- `getCurrentOffset(path)` — latest offset
- `messageCount(path)` — SQL count
- `close()` — closes all file descriptors + SQLite

## TypedLog

**File**: `packages/db/src/typed-log.ts` — schema-validated append-only log wrapper.

```
typedLog(store, streamPath, valibotSchema) → { append, read, count, streamPath }
```

- `append(record)` — validates with Valibot, serializes to JSON, delegates to engine
- `read(options?)` — decodes JSON, optionally re-validates. Silently skips corrupted lines.

## SQLite Initialization

**File**: `packages/db/src/init.ts` — `SQLiteManager` singleton.

Priority order for SQLite library:
1. Custom-compiled `libsqlite3-vec.*` (with vector support)
2. Homebrew SQLite + runtime `sqlite-vec` loading
3. Bun's built-in SQLite (no vector support)

All databases initialized with `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. Drizzle migrations auto-applied on open.

## createDB()

**File**: `packages/db/src/index.ts`

Low-level access: returns `{db: DrizzleInstance, sqlite: RawDatabase, schema}`. Used by DurableStore and tests.

## Virtual Tables (WIP)
- `messages_fts` — FTS5 full-text search (created but not yet populated)
- `messages_vec` — vector similarity via sqlite-vec (gracefully skipped if unavailable)
