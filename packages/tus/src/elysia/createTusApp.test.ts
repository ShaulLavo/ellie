import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createTusApp } from './createTusApp'
import { FileStore, Upload } from '../index'

describe('createTusApp', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('serves upload content with mimeType metadata', async () => {
		const dataDir = mkdtempSync(
			join(tmpdir(), 'tus-app-test-')
		)
		tempDirs.push(dataDir)

		const fileStore = new FileStore({ directory: dataDir })
		const uploadId = 'trace/trace-1/span-1/prompt/blob.txt'
		const content = 'hello blob'
		const upload = new Upload({
			id: uploadId,
			size: Buffer.byteLength(content),
			offset: 0,
			metadata: {
				mimeType: 'text/plain'
			}
		})

		await fileStore.create(upload)
		await fileStore.write(
			Readable.from(Buffer.from(content)),
			uploadId,
			0
		)

		const app = createTusApp({ datastore: fileStore })
		const response = await app.handle(
			new Request(
				`http://localhost/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`
			)
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe(
			'text/plain'
		)
		expect(await response.text()).toBe(content)
	})

	test('serves ranged upload content for seekable media', async () => {
		const dataDir = mkdtempSync(
			join(tmpdir(), 'tus-app-test-')
		)
		tempDirs.push(dataDir)

		const fileStore = new FileStore({ directory: dataDir })
		const uploadId = 'audio/message-1.m4a'
		const content = '0123456789'
		const upload = new Upload({
			id: uploadId,
			size: Buffer.byteLength(content),
			offset: 0,
			metadata: {
				mimeType: 'audio/mp4'
			}
		})

		await fileStore.create(upload)
		await fileStore.write(
			Readable.from(Buffer.from(content)),
			uploadId,
			0
		)

		const app = createTusApp({ datastore: fileStore })
		const response = await app.handle(
			new Request(
				`http://localhost/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`,
				{
					headers: {
						Range: 'bytes=2-5'
					}
				}
			)
		)

		expect(response.status).toBe(206)
		expect(response.headers.get('accept-ranges')).toBe(
			'bytes'
		)
		expect(response.headers.get('content-range')).toBe(
			'bytes 2-5/10'
		)
		expect(response.headers.get('content-length')).toBe('4')
		expect(await response.text()).toBe('2345')
	})

	test('rejects invalid byte ranges', async () => {
		const dataDir = mkdtempSync(
			join(tmpdir(), 'tus-app-test-')
		)
		tempDirs.push(dataDir)

		const fileStore = new FileStore({ directory: dataDir })
		const uploadId = 'audio/message-2.m4a'
		const content = '0123456789'
		const upload = new Upload({
			id: uploadId,
			size: Buffer.byteLength(content),
			offset: 0,
			metadata: {
				mimeType: 'audio/mp4'
			}
		})

		await fileStore.create(upload)
		await fileStore.write(
			Readable.from(Buffer.from(content)),
			uploadId,
			0
		)

		const app = createTusApp({ datastore: fileStore })
		const response = await app.handle(
			new Request(
				`http://localhost/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`,
				{
					headers: {
						Range: 'bytes=999-'
					}
				}
			)
		)

		expect(response.status).toBe(416)
		expect(response.headers.get('content-range')).toBe(
			'bytes */10'
		)
	})
})
