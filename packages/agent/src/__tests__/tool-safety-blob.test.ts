import { describe, test, expect } from 'bun:test'
import {
	truncateToolResultWithBlob,
	needsTruncation
} from '../tool-safety'
import type {
	BlobRef,
	BlobSink,
	BlobWriteOptions,
	TraceScope
} from '@ellie/trace'
import type { AgentToolResult } from '../types'

// ── Test helpers ────────────────────────────────────────────────────────────

function makeScope(): TraceScope {
	return {
		traceId: 'trace-1',
		spanId: 'span-1',
		sessionId: 'sess-1',
		runId: 'run-1',
		traceKind: 'chat'
	}
}

function makeResult(text: string): AgentToolResult {
	return {
		content: [{ type: 'text', text }],
		details: undefined
	}
}

function makeMockBlobSink(
	overrides?: Partial<BlobSink>
): BlobSink {
	return {
		write: async opts => ({
			uploadId: `upload-${Date.now()}`,
			storagePath: `trace/${opts.traceId}/${opts.spanId}/${opts.role}/blob.${opts.ext}`,
			mimeType: opts.mimeType,
			sizeBytes: Buffer.isBuffer(opts.content)
				? opts.content.length
				: Buffer.from(opts.content as string).length,
			ohash: 'mock-hash',
			role: opts.role
		}),
		...overrides
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('truncateToolResultWithBlob', () => {
	test('returns unchanged result when under limit', async () => {
		const result = makeResult('short text')
		const sink = makeMockBlobSink()
		const scope = makeScope()

		const truncated = await truncateToolResultWithBlob(
			result,
			50_000,
			{ blobSink: sink, traceScope: scope }
		)

		expect(truncated).toBe(result) // same reference
	})

	test('truncates and stores overflow as blob', async () => {
		const bigText = 'x'.repeat(60_000)
		const result = makeResult(bigText)
		const scope = makeScope()

		let writtenOpts: BlobWriteOptions | null = null
		const sink = makeMockBlobSink({
			write: async opts => {
				writtenOpts = opts
				return {
					uploadId: 'overflow-blob-1',
					storagePath: `trace/${opts.traceId}/${opts.spanId}/${opts.role}/blob.txt`,
					mimeType: 'text/plain',
					sizeBytes: Buffer.isBuffer(opts.content)
						? opts.content.length
						: Buffer.from(opts.content as string).length,
					ohash: 'hash-1',
					role: opts.role
				}
			}
		})

		const truncated = await truncateToolResultWithBlob(
			result,
			50_000,
			{ blobSink: sink, traceScope: scope }
		)

		// Result should be truncated
		const textContent = truncated.content.find(
			c => c.type === 'text'
		)
		expect(textContent).toBeTruthy()
		expect(
			(textContent as { text: string }).text.length
		).toBeLessThan(bigText.length)

		// Should have overflowRef in details
		const details = truncated.details as Record<
			string,
			unknown
		>
		expect(details.overflowRef).toBeTruthy()
		const ref = details.overflowRef as BlobRef
		expect(ref.uploadId).toBe('overflow-blob-1')
		expect(ref.role).toBe('tool_result_full')

		// Blob sink should have been called with full content
		expect(writtenOpts).toBeTruthy()
		expect(writtenOpts!.traceId).toBe('trace-1')
		expect(writtenOpts!.spanId).toBe('span-1')
		expect(writtenOpts!.role).toBe('tool_result_full')
		expect(writtenOpts!.mimeType).toBe('text/plain')
	})

	test('fail-closed: throws on blob write failure', async () => {
		const bigText = 'x'.repeat(60_000)
		const result = makeResult(bigText)
		const scope = makeScope()

		const failingSink = makeMockBlobSink({
			write: async () => {
				throw new Error('TUS write failed')
			}
		})

		await expect(
			truncateToolResultWithBlob(result, 50_000, {
				blobSink: failingSink,
				traceScope: scope
			})
		).rejects.toThrow('TUS write failed')
	})

	test('truncation suffix mentions blob uploadId', async () => {
		const bigText = 'x'.repeat(60_000)
		const result = makeResult(bigText)
		const scope = makeScope()

		const sink = makeMockBlobSink({
			write: async opts => ({
				uploadId: 'my-blob-id',
				storagePath: 'path',
				mimeType: 'text/plain',
				sizeBytes: 100,
				ohash: 'h',
				role: opts.role
			})
		})

		const truncated = await truncateToolResultWithBlob(
			result,
			50_000,
			{ blobSink: sink, traceScope: scope }
		)

		const textContent = truncated.content.find(
			c => c.type === 'text'
		) as { text: string }
		expect(textContent.text).toContain('my-blob-id')
	})
})

describe('needsTruncation', () => {
	test('returns false for short content', () => {
		expect(needsTruncation(makeResult('short'))).toBe(false)
	})

	test('returns true for content exceeding limit', () => {
		expect(
			needsTruncation(
				makeResult('x'.repeat(60_000)),
				50_000
			)
		).toBe(true)
	})
})
