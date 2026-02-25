import type { GenericSchema, InferOutput } from 'valibot'
import * as v from 'valibot'

export interface StreamMessage {
	data: Uint8Array
	offset?: string
	timestamp?: number
}

const decoder = new TextDecoder()

/**
 * Decode a comma-terminated JSON message and validate against a Valibot schema.
 * Messages from the store are comma-terminated (e.g. `{"role":"user"},`).
 * Strips the trailing comma before parsing, then checks against the schema.
 */
export function decodeAndValidate<T extends GenericSchema>(
	msg: StreamMessage,
	schema: T
): InferOutput<T> {
	const bytes = msg.data
	// Strip trailing whitespace and comma (store format from processJsonAppend)
	let end = bytes.length
	while (
		end > 0 &&
		(bytes[end - 1] === 0x20 ||
			bytes[end - 1] === 0x0a ||
			bytes[end - 1] === 0x0d ||
			bytes[end - 1] === 0x09)
	) {
		end--
	}
	if (end > 0 && bytes[end - 1] === 0x2c) {
		end--
	}

	const text = decoder.decode(end === bytes.length ? bytes : bytes.subarray(0, end))
	const parsed: unknown = JSON.parse(text)

	const result = v.safeParse(schema, parsed)
	if (!result.success) {
		const detail = result.issues
			.map(e => `${e.path?.map(p => p.key).join('.') ?? '/'}: ${e.message}`)
			.join(`, `)
		throw new Error(`Stream message failed schema validation: ${detail}`)
	}

	return result.output
}
