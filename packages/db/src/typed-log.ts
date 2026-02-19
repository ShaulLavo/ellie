import type { z } from "zod"
import type { JsonlStore as LogStore } from "./jsonl-store"

// -- Types --------------------------------------------------------------------

export interface TypedLogRecord<T> {
  data: T
  offset: string
  timestamp: number
}

export interface TypedLogReadOptions {
  /** Only return records after this offset (exclusive). */
  after?: string
  /** Re-validate records against the schema on read. Default: false. */
  validate?: boolean
}

export interface TypedLog<T> {
  /** Validate and append a record. Throws ZodError on invalid input. */
  append(record: T): {
    offset: string
    bytePos: number
    length: number
    timestamp: number
  }

  /** Read records, optionally after an offset. Silently skips corrupted lines. */
  read(options?: TypedLogReadOptions): TypedLogRecord<T>[]

  /** Number of records in this log. */
  count(): number

  /** The stream path this log writes to. */
  readonly streamPath: string
}

// -- Implementation -----------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Create a typed, schema-validated append-only log.
 *
 * Wraps a LogStore stream with Zod validation on write
 * and typed JSON deserialization on read.
 *
 * ```typescript
 * const events = typedLog(store, "/events/ui", eventSchema)
 * events.append({ type: "click", x: 100 })  // validated + typed
 * events.read()  // Array<{ data: Event, offset, timestamp }>
 * ```
 */
export function typedLog<S extends z.ZodType>(
  store: LogStore,
  streamPath: string,
  schema: S,
  options?: { contentType?: string }
): TypedLog<z.infer<S>> {
  // Ensure the stream exists (idempotent)
  store.createStream(streamPath, {
    contentType: options?.contentType ?? "application/json",
  })

  return {
    get streamPath() {
      return streamPath
    },

    append(record: z.infer<S>) {
      // Validate with Zod — throws ZodError if invalid
      const validated = schema.parse(record)

      // Serialize the validated (possibly transformed) value
      const json = JSON.stringify(validated)
      const bytes = encoder.encode(json)

      return store.append(streamPath, bytes)
    },

    read(opts?: TypedLogReadOptions): TypedLogRecord<z.infer<S>>[] {
      const messages = store.read(streamPath, opts?.after)
      const results: TypedLogRecord<z.infer<S>>[] = []

      for (const msg of messages) {
        try {
          const json = decoder.decode(msg.data)
          const parsed = JSON.parse(json)
          const data = opts?.validate ? schema.parse(parsed) : parsed

          results.push({
            data,
            offset: msg.offset,
            timestamp: msg.timestamp,
          })
        } catch {
          // Skip corrupted/malformed lines — don't abort the entire read
          continue
        }
      }

      return results
    },

    count() {
      return store.messageCount(streamPath)
    },
  }
}
