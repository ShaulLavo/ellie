# Durable Streams Protocol

REST-based append-only log with real-time subscriptions, idempotent producers, and cursor-based pagination.

## HTTP Endpoints

All operations are on a stream path (e.g., `/chat/abc`):

| Method | Operation | Key behavior |
|--------|-----------|--------------|
| `PUT` | Create | Idempotent. 201 new / 200 exists / 409 config mismatch |
| `HEAD` | Check existence | Returns metadata headers only |
| `GET` | Read | Snapshot, long-poll, or SSE depending on `?live=` param |
| `POST` | Append (+ optional close) | Supports producer idempotency headers |
| `DELETE` | Delete | Soft-delete. Notifies all subscribers with `deleted` event |

## Headers

**Request/Response:**
- `Stream-Next-Offset` — next offset to read from
- `Stream-Cursor` — CDN collapsing cursor (echo in subsequent long-polls)
- `Stream-Up-To-Date` — presence = response reaches current tail
- `Stream-Closed` — `true` when stream is permanently closed
- `Stream-TTL` / `Stream-Expires-At` — TTL or absolute expiry on create

**Producer headers (for idempotent appends):**
- `Producer-Id`, `Producer-Epoch`, `Producer-Seq` — identify + sequence the producer
- `Producer-Expected-Seq` / `Producer-Received-Seq` — returned on 409 sequence conflict

## Offset Format

Opaque token: `{readSeq}_{byteOffset}` — each 16-digit zero-padded, lexicographically sortable.

Special values: `-1` (beginning of stream), `now` (current tail).

See `packages/db/src/jsonl-store.ts:formatOffset()`.

## Live Modes (GET `?live=`)

**Catch-up (default):** `?live=false` — reads from offset, returns when up-to-date.

**Long-poll:** `?live=long-poll` — blocks up to 30s if caught up, returns 204 on timeout.

**SSE:** `?live=sse` — keeps connection open. Two event types:
- `event: data` — message payload
- `event: control` — JSON metadata (`streamNextOffset`, `upToDate`, `streamClosed`)

See `packages/durable-streams/src/server/routes/read.ts`.

## Producer Idempotency

Producers identify via `(Producer-Id, Producer-Epoch, Producer-Seq)`. Server validates:

| Scenario | Server response |
|----------|----------------|
| New producer, seq=0 | 200 — accepted |
| Same epoch, seq = lastSeq + 1 | 200 — appended |
| Same epoch, seq <= lastSeq | 204 — duplicate, no-op |
| Stale epoch (< stored) | 403 — zombie fenced |
| New epoch, seq=0 | 200 — epoch reset accepted |
| Sequence gap | 409 — expected/received seq in headers |

See `packages/durable-streams/src/store.ts:validateProducer()`.

**Client-side:** `IdempotentProducer` in `packages/streams-client/src/idempotent-producer.ts` handles batching, pipelining (up to 5 in-flight), and auto-claim on stale epoch.

## JSON Append Processing

Arrays are split into individual items; objects appended as single items. Server stores with comma suffix and reconstructs as valid JSON array `[item1, item2, ..., itemN]` on read.

See `packages/durable-streams/src/store.ts:processJsonAppend()`.

## Stream Lifecycle

1. **Create** — `PUT` with optional content-type, TTL, initial data
2. **Append** — `POST` with JSON body + optional producer headers
3. **Read** — `GET` with offset + live mode
4. **Subscribe** — `GET ?live=sse` or `?live=long-poll` for real-time updates
5. **Close** — `POST` with `Stream-Closed: true` (optionally with final data)
6. **Delete** — `DELETE` soft-deletes, notifies subscribers

## Multi-Client Sync

Each client tracks its own offset. The `subscribe()` method on DurableStore:
- If messages exist past offset: callback immediately
- If caught up and closed: callback with `closed` event
- Otherwise: register callback, fire on new appends

On clear/delete: all subscribers get a `deleted` event, fresh JSONL file created on recreate.

See `packages/durable-streams/src/durable-store.ts`.

## Two Store Implementations

| Class | Location | Purpose |
|-------|----------|---------|
| `StreamStore` | `packages/durable-streams/src/store.ts` | In-memory, used in tests |
| `DurableStore` | `packages/durable-streams/src/durable-store.ts` | Disk-backed via JsonlEngine, no in-memory cache |

Both implement `IStreamStore` from `packages/durable-streams/src/server/lib/context.ts`.

## Other Details

- **ETag:** `"{btoa(path)}:{startOffset}:{responseOffset}{:c if closed}"` — supports 304 Not Modified
- **Compression:** gzip/deflate/brotli above 1KB threshold (`packages/durable-streams/src/server/lib/compression.ts`)
- **Cursor system:** Time-interval based for CDN collapsing, with jitter (`packages/durable-streams/src/cursor.ts`)
- **Conformance tests:** `packages/durable-streams/src/server-conformance-suite.ts` (comprehensive protocol compliance suite)
