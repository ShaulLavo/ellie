import { describe, test, expect } from 'bun:test'
import { readJsonLines } from './jsonl-reader'

function streamFrom(
	chunks: string[]
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk))
			}
			controller.close()
		}
	})
}

async function collect(
	stream: ReadableStream<Uint8Array>
): Promise<Record<string, unknown>[]> {
	const results: Record<string, unknown>[] = []
	for await (const obj of readJsonLines(stream)) {
		results.push(obj)
	}
	return results
}

describe('readJsonLines', () => {
	test('parses single complete JSON line', async () => {
		const stream = streamFrom([
			'{"event":"progress","phase":"denoise"}\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([
			{ event: 'progress', phase: 'denoise' }
		])
	})

	test('parses multiple JSON lines in one chunk', async () => {
		const stream = streamFrom([
			'{"a":1}\n{"b":2}\n{"c":3}\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
	})

	test('handles lines split across multiple chunks', async () => {
		const stream = streamFrom([
			'{"event":"pro',
			'gress","pha',
			'se":"load"}\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([
			{ event: 'progress', phase: 'load' }
		])
	})

	test('handles trailing newline', async () => {
		const stream = streamFrom(['{"x":1}\n'])
		const results = await collect(stream)
		expect(results).toEqual([{ x: 1 }])
	})

	test('handles no trailing newline', async () => {
		const stream = streamFrom(['{"x":1}'])
		const results = await collect(stream)
		expect(results).toEqual([{ x: 1 }])
	})

	test('skips malformed lines without crashing', async () => {
		const stream = streamFrom([
			'not json\n{"valid":true}\nmore garbage\n{"also":"valid"}\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([
			{ valid: true },
			{ also: 'valid' }
		])
	})

	test('handles empty lines gracefully', async () => {
		const stream = streamFrom([
			'\n\n{"a":1}\n\n{"b":2}\n\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('handles empty stream', async () => {
		const stream = streamFrom([])
		const results = await collect(stream)
		expect(results).toEqual([])
	})

	test('handles mixed complete and partial lines across chunks', async () => {
		const stream = streamFrom([
			'{"a":1}\n{"b":',
			'2}\n{"c":3}\n'
		])
		const results = await collect(stream)
		expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
	})
})
