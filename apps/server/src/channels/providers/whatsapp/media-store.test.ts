import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { saveInboundMedia } from './media-store'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('saveInboundMedia', () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(
			join(tmpdir(), 'media-store-test-')
		)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('saves file with correct extension from MIME', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.from('fake-image-data'),
			mimetype: 'image/jpeg',
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
		expect(result!.path).toContain('.jpg')
		expect(existsSync(result!.path)).toBe(true)
	})

	test('saves file with extension from fileName', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.from('fake-doc'),
			mimetype: 'application/pdf',
			fileName: 'report.pdf',
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
		expect(result!.path).toContain('.pdf')
	})

	test('creates inbound media directory', async () => {
		await saveInboundMedia({
			buffer: Buffer.from('data'),
			mimetype: 'image/png',
			dataDir: tmpDir
		})
		const mediaDir = join(
			tmpDir,
			'channels',
			'whatsapp',
			'media',
			'inbound'
		)
		expect(existsSync(mediaDir)).toBe(true)
	})

	test('rejects files exceeding maxBytes', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.alloc(1000),
			mimetype: 'image/png',
			dataDir: tmpDir,
			maxBytes: 500
		})
		expect(result).toBeNull()
	})

	test('uses default maxBytes of 50MB', async () => {
		// A small file should pass
		const result = await saveInboundMedia({
			buffer: Buffer.from('small'),
			mimetype: 'image/png',
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
	})

	test('handles unknown MIME type', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.from('data'),
			mimetype: 'application/x-custom',
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
		expect(result!.path).toContain('.x-custom')
	})

	test('handles ogg audio MIME', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.from('audio'),
			mimetype: 'audio/ogg; codecs=opus',
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
		expect(result!.path).toContain('.ogg')
	})

	test('handles no MIME type', async () => {
		const result = await saveInboundMedia({
			buffer: Buffer.from('data'),
			dataDir: tmpDir
		})
		expect(result).not.toBeNull()
		expect(result!.path).toContain('.bin')
	})
})
