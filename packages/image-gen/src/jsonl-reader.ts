/**
 * Async generator that reads a ReadableStream<Uint8Array> and yields
 * parsed JSON objects line-by-line. Buffers partial lines across chunks.
 */

export async function* readJsonLines(
	stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			buffer += decoder.decode(value, { stream: true })

			const lines = buffer.split('\n')
			// Keep the last element as the incomplete line buffer
			buffer = lines.pop() ?? ''

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					yield JSON.parse(trimmed)
				} catch {
					// Skip malformed lines (e.g. Python print statements)
				}
			}
		}

		// Process any remaining data in the buffer
		const remaining = buffer.trim()
		if (remaining) {
			try {
				yield JSON.parse(remaining)
			} catch {
				// Skip malformed trailing data
			}
		}
	} finally {
		reader.releaseLock()
	}
}
