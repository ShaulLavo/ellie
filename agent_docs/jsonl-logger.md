# JSONL Logger

The JSONL logger plays a big role in the system — it is the actual persistence layer for all message data. Every chat message flows through it. SQLite only stores metadata pointers; the JSONL files hold the real content.

## How It Fits In

```
DurableStore.append()
  → JsonlEngine.append()
    → LogFile.append()       ← writes raw bytes to .jsonl file
    → SQLite transaction     ← inserts pointer (bytePos, length, offset)
```

All reads reverse this: query SQLite for pointers, then `readAt(bytePos, length)` from the JSONL file.

There is **no in-memory message cache**. Every read hits disk. This is intentional — it keeps the server stateless and observable.

## LogFile (`packages/db/src/log.ts`)

Low-level append-only file handle.

| Method | What it does |
|--------|--------------|
| `append(data: Uint8Array)` | Write data + newline, return `{bytePos, length}` |
| `readAt(bytePos, length)` | Positioned read (no seeking) |
| `readRange(entries[])` | Batch positioned reads |
| `readFrom(bytePos)` | Read from position to EOF |
| `close()` | Close file descriptor (idempotent) |
| `get size` | Current file size in bytes |

Opens with `O_RDWR | O_CREAT | O_APPEND`. Tracks `currentSize` in memory for append position. Two `writeSync` calls per append (data + newline) are atomic in single-threaded Bun.

## On-Disk Format

Each stream gets one `.jsonl` file. One JSON object per line, newline-terminated:

```
{"role":"user","content":"hello"}
{"role":"assistant","content":"Hi there!"}
```

**Path → filename**: `/chat/session-1` → `chat__session-1.jsonl` (slashes become `__`).

Security: rejects null bytes, `..`, `:`, `\`, `<`, `>`, `|`, `"`, `?`, control chars.

See `streamPathToFilename()` in `packages/db/src/log.ts`.

**On-disk layout:**
```
DATA_DIR/
├── streams.db          # SQLite metadata
├── streams.db-wal
└── logs/
    └── chat__session-1.jsonl
```

## JsonlEngine (`packages/db/src/jsonl-store.ts`)

Orchestrates JSONL files + SQLite metadata.

### Two-Phase Append

1. Write bytes to JSONL file → get `{bytePos, length}`
2. **Atomic SQLite transaction**: insert message pointer row + update stream's `currentByteOffset`

If the transaction fails, the JSONL data is orphaned but the database stays consistent. The reverse (metadata succeeds, file write fails) cannot happen because file write runs first.

### Read

1. Query SQLite `messages` table (optionally `WHERE offset > afterOffset`)
2. For each row: `LogFile.readAt(bytePos, length)`
3. Return `JsonlMessage[]` — `{data: Uint8Array, offset, timestamp}`

### Offset Format

`formatOffset(readSeq, byteOffset)` → `"0000000000000000_0000000000000042"`

16-digit zero-padded `readSeq` + underscore + 16-digit zero-padded `byteOffset`. Lexicographically sortable — enables string comparison in SQLite `WHERE offset > ?`.

### Stream Resurrection

When a soft-deleted stream is recreated:
- Bumps `currentReadSeq` (invalidates all old offsets)
- Resets `currentByteOffset` to 0
- Deletes old message and producer rows
- JSONL file stays on disk (orphaned data is harmless)

### File Descriptor Pooling

`openLogs: Map<string, LogFile>` caches open file handles per stream. Reopening resumes from `currentSize`. Handles are closed on stream delete.

## TypedLog (`packages/db/src/typed-log.ts`)

Schema-validated wrapper around JsonlEngine.

```
typedLog(engine, streamPath, valibotSchema) → { append, read, count, streamPath }
```

**Append**: validate with Valibot → `JSON.stringify` → `TextEncoder.encode` → `engine.append()`

**Read**: `engine.read()` → `TextDecoder.decode` → `JSON.parse` → optionally re-validate. **Silently skips corrupted lines** — a malformed entry won't break reads.

## SQLite Pointer Table

The `messages` table stores pointers only, not data:

| Column | Purpose |
|--------|---------|
| `streamPath` | FK to streams table |
| `bytePos` | Position in JSONL file |
| `length` | Bytes to read |
| `offset` | Formatted offset string |
| `timestamp` | Unix millis |

Index on `(streamPath, offset)` for efficient range queries.

## Key Details

- **No cache**: reads always hit disk. Keeps server stateless.
- **Corruption resilient**: TypedLog skips bad lines, JSONL file stays usable.
- **Human-readable**: JSONL files are grep-able (`grep '"error"' logs/mystream.jsonl`).
- **WAL mode**: SQLite runs with Write-Ahead Logging for concurrent readers + single writer.
- **Atomic guarantee**: file write → then metadata transaction. Never the reverse.
