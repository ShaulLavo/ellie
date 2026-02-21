import type { GenericSchema, InferOutput } from "valibot"
import { parse } from "valibot"
import type { JsonlEngine as LogStore } from "./jsonl-store"

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
  /** Validate and append a record. Throws ValiError on invalid input. */
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
 * Wraps a LogStore stream with Valibot validation on write
 * and typed JSON deserialization on read.
 *
 * When a `schemaKey` is provided, the schema is registered on the engine
 * and the stream is created with schema enforcement — the engine validates
 * every append against the Valibot schema, even for direct `engine.append()`.
 *
 * ```typescript
 * const events = typedLog(store, "/events/ui", eventSchema, {
 *   schemaKey: "uiEvent",  // enables engine-level enforcement
 * })
 * events.append({ type: "click", x: 100 })  // validated + typed
 * events.read()  // Array<{ data: Event, offset, timestamp }>
 * ```
 */
export function typedLog<S extends GenericSchema>(
  store: LogStore,
  streamPath: string,
  schema: S,
  options?: { contentType?: string; schemaKey?: string }
): TypedLog<InferOutput<S>> {
  // Register schema on the engine if a key is provided
  if (options?.schemaKey) {
    store.registerSchema(options.schemaKey, schema)
  }

  // Ensure the stream exists (idempotent)
  store.createStream(streamPath, {
    contentType: options?.contentType ?? "application/json",
    schemaKey: options?.schemaKey,
  })

  return {
    get streamPath() {
      return streamPath
    },

    append(record: InferOutput<S>) {
      // Validate with Valibot — throws ValiError if invalid
      const validated = parse(schema, record)

      // Serialize the validated (possibly transformed) value
      const json = JSON.stringify(validated)
      const bytes = encoder.encode(json)

      return store.append(streamPath, bytes)
    },

    read(opts?: TypedLogReadOptions): TypedLogRecord<InferOutput<S>>[] {
      const messages = store.read(streamPath, opts?.after)
      const results: TypedLogRecord<InferOutput<S>>[] = []

      for (const msg of messages) {
        try {
          const json = decoder.decode(msg.data)
          const parsed = JSON.parse(json)
          const data = opts?.validate ? parse(schema, parsed) : parsed

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
