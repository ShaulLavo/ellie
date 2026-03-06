import {
	describe,
	test,
	expect,
	beforeEach
} from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileStore } from '@ellie/tus'
import {
	TusBlobSink,
	BLOB_THRESHOLD,
	shouldBlob
} from '../blob-sink'

describe('shouldBlob', () => {
	test('returns true for Buffer content', () => {
		expect(shouldBlob(Buffer.from('hello'))).toBe(true)
	})

	test('returns true when content was truncated', () => {
		expect(shouldBlob('short string', true)).toBe(true)
	})

	test('returns false for short string', () => {
		expect(shouldBlob('short string')).toBe(false)
	})

	test('returns true for string exceeding threshold', () => {
		const bigString = 'x'.repeat(BLOB_THRESHOLD + 1)
		expect(shouldBlob(bigString)).toBe(true)
	})

	test('returns false for string at threshold', () => {
		const atThreshold = 'x'.repeat(BLOB_THRESHOLD)
		expect(shouldBlob(atThreshold)).toBe(false)
	})
})

describe('TusBlobSink', () => {
	let dataDir: string
	let fileStore: FileStore
	let sink: TusBlobSink

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'blob-sink-test-'))
		fileStore = new FileStore({ directory: dataDir })
		sink = new TusBlobSink(fileStore)
	})

	test('writes blob and returns BlobRef with correct fields', async () => {
		const ref = await sink.write({
			traceId: 'trace-1',
			spanId: 'span-1',
			role: 'tool_result_full',
			content: 'hello world',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref.uploadId).toBeTruthy()
		expect(ref.storagePath).toContain(
			'trace/trace-1/span-1/tool_result_full/'
		)
		expect(ref.storagePath).toMatch(/\.txt$/)
		expect(ref.mimeType).toBe('text/plain')
		expect(ref.sizeBytes).toBe(
			Buffer.from('hello world').length
		)
		expect(ref.ohash).toBeTruthy()
		expect(ref.role).toBe('tool_result_full')
	})

	test('uploadId equals storagePath', async () => {
		const ref = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'test',
			content: 'data',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref.uploadId).toBe(ref.storagePath)
	})

	test('preview is provided for text content', async () => {
		const ref = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'test',
			content: 'some text content',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref.preview).toBe('some text content')
	})

	test('preview is truncated for large text', async () => {
		const largeContent = 'x'.repeat(3000)
		const ref = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'test',
			content: largeContent,
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref.preview).toBeTruthy()
		expect(ref.preview!.length).toBeLessThan(
			largeContent.length
		)
		expect(ref.preview).toContain('[... 1000 more chars]')
	})

	test('no preview for Buffer content', async () => {
		const ref = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'test',
			content: Buffer.from('binary data'),
			mimeType: 'application/octet-stream',
			ext: 'bin'
		})

		expect(ref.preview).toBeUndefined()
	})

	test('ohash is deterministic for same content', async () => {
		const ref1 = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'a',
			content: 'same content',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		const ref2 = await sink.write({
			traceId: 't2',
			spanId: 's2',
			role: 'b',
			content: 'same content',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref1.ohash).toBe(ref2.ohash)
	})

	test('different content produces different ohash', async () => {
		const ref1 = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'a',
			content: 'content A',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		const ref2 = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'b',
			content: 'content B',
			mimeType: 'text/plain',
			ext: 'txt'
		})

		expect(ref1.ohash).not.toBe(ref2.ohash)
	})

	test('written blob can be read back from FileStore', async () => {
		const content = 'readable content for verification'
		const ref = await sink.write({
			traceId: 't1',
			spanId: 's1',
			role: 'test',
			content,
			mimeType: 'text/plain',
			ext: 'txt'
		})

		// Verify upload exists in the store
		const upload = await fileStore.getUpload(ref.uploadId)
		expect(upload.size).toBe(Buffer.from(content).length)
		expect(upload.offset).toBe(Buffer.from(content).length)
	})
})
