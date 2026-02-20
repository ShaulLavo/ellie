import type { TSchema } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import type { StreamMessage } from "@ellie/durable-streams"

const decoder = new TextDecoder()

/**
 * Decode a comma-terminated JSON message and validate against a TypeBox schema.
 * Messages from the store are comma-terminated (e.g. `{"role":"user"},`).
 * Strips the trailing comma before parsing, then checks against the schema.
 */
export function decodeAndValidate<T extends TSchema>(
  msg: StreamMessage,
  schema: T,
): unknown {
  const bytes = msg.data
  // Strip trailing whitespace and comma (store format from processJsonAppend)
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x09)) {
    end--
  }
  if (end > 0 && bytes[end - 1] === 0x2c) {
    end--
  }

  const text = decoder.decode(end === bytes.length ? bytes : bytes.subarray(0, end))
  const parsed: unknown = JSON.parse(text)

  if (!Value.Check(schema, parsed)) {
    const errors = [...Value.Errors(schema, parsed)]
    const detail = errors.length > 0
      ? errors.map((e) => `${e.path}: ${e.message}`).join(`, `)
      : `unknown`
    throw new Error(`Stream message failed schema validation: ${detail}`)
  }

  return parsed
}
