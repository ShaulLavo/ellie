import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import * as fsProm from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { TusServer } from '../src/core/server'
import { FileStore } from '../src/stores/file-store'
import { TUS_RESUMABLE } from '../src/core/constants'

let tmpDir: string
let store: FileStore
let server: TusServer
const TUS_PATH = '/api/uploads'

beforeEach(async () => {
	tmpDir = await fsProm.mkdtemp(
		path.join(os.tmpdir(), 'tus-test-')
	)
	store = new FileStore({
		directory: tmpDir,
		expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000
	})
	server = new TusServer({
		path: TUS_PATH,
		datastore: store,
		relativeLocation: true
	})
})

afterEach(async () => {
	await fsProm.rm(tmpDir, { recursive: true, force: true })
})

function tusHeaders(
	extra: Record<string, string> = {}
): Record<string, string> {
	return {
		'Tus-Resumable': TUS_RESUMABLE,
		...extra
	}
}

// ── OPTIONS ─────────────────────────────────────────────────────────────────

describe('OPTIONS', () => {
	it('returns Tus-Version, Tus-Extension, and CORS headers', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'OPTIONS'
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(204)
		expect(res.headers.get('Tus-Version')).toBe('1.0.0')
		expect(res.headers.get('Tus-Extension')).toContain(
			'creation'
		)
		expect(res.headers.get('Tus-Extension')).toContain(
			'termination'
		)
		expect(res.headers.get('Tus-Extension')).toContain(
			'expiration'
		)
		expect(
			res.headers.get('Access-Control-Allow-Methods')
		).toContain('POST')
		expect(
			res.headers.get('Access-Control-Allow-Methods')
		).toContain('PATCH')
		expect(
			res.headers.get('Access-Control-Allow-Headers')
		).toContain('Upload-Length')
	})

	it('returns Tus-Max-Size when configured', async () => {
		const s = new TusServer({
			path: TUS_PATH,
			datastore: store,
			maxSize: 1024 * 1024,
			relativeLocation: true
		})
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'OPTIONS'
			}
		)
		const res = await s.handle(req)
		expect(res.headers.get('Tus-Max-Size')).toBe('1048576')
	})
})

// ── POST (create upload) ────────────────────────────────────────────────────

describe('POST create upload', () => {
	it('creates upload with Upload-Length and returns 201 + Location', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(201)
		expect(res.headers.get('Location')).toBeTruthy()
		expect(
			res.headers
				.get('Location')!
				.startsWith('/api/uploads/')
		).toBe(true)
	})

	it('creates upload with metadata', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100',
					'Upload-Metadata':
						'filename dGVzdC50eHQ=,type dGV4dC9wbGFpbg=='
				})
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(201)
	})

	it('rejects missing Upload-Length and Upload-Defer-Length', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({})
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(400)
	})

	it('rejects invalid metadata', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100',
					'Upload-Metadata': 'invalid metadata!'
				})
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(400)
	})

	it('rejects when exceeding maxSize', async () => {
		const s = new TusServer({
			path: TUS_PATH,
			datastore: store,
			maxSize: 50,
			relativeLocation: true
		})
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const res = await s.handle(req)
		expect(res.status).toBe(413)
	})
})

// ── POST creation-with-upload ───────────────────────────────────────────────

describe('POST creation-with-upload', () => {
	it('writes body data and returns Upload-Offset', async () => {
		const data = new Uint8Array(50)
		data.fill(65) // 'A'
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '50',
					'Content-Type': 'application/offset+octet-stream'
				}),
				body: data
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(201)
		expect(res.headers.get('Upload-Offset')).toBe('50')
	})
})

// ── HEAD ────────────────────────────────────────────────────────────────────

describe('HEAD status', () => {
	it('returns Upload-Offset and Upload-Length', async () => {
		// Create an upload first
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const location = createRes.headers.get('Location')!
		const id = location.split('/').pop()!

		// HEAD request
		const headReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'HEAD',
				headers: tusHeaders({})
			}
		)
		const res = await server.handle(headReq)
		expect(res.status).toBe(200)
		expect(res.headers.get('Upload-Offset')).toBe('0')
		expect(res.headers.get('Upload-Length')).toBe('100')
		expect(res.headers.get('Cache-Control')).toBe(
			'no-store'
		)
	})

	it('returns Upload-Defer-Length for deferred uploads', async () => {
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Defer-Length': '1'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		const headReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'HEAD',
				headers: tusHeaders({})
			}
		)
		const res = await server.handle(headReq)
		expect(res.status).toBe(200)
		expect(res.headers.get('Upload-Defer-Length')).toBe('1')
		expect(res.headers.get('Upload-Length')).toBeNull()
	})

	it('reflects metadata', async () => {
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100',
					'Upload-Metadata': 'filename dGVzdA=='
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		const headReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'HEAD',
				headers: tusHeaders({})
			}
		)
		const res = await server.handle(headReq)
		expect(res.headers.get('Upload-Metadata')).toContain(
			'filename'
		)
	})

	it('returns 404 for non-existent upload', async () => {
		const headReq = new Request(
			'http://localhost:3000/api/uploads/nonexistent',
			{
				method: 'HEAD',
				headers: tusHeaders({})
			}
		)
		const res = await server.handle(headReq)
		expect(res.status).toBe(404)
	})
})

// ── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH append', () => {
	it('advances upload offset and returns 204', async () => {
		// Create upload
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		// PATCH with 50 bytes
		const data = new Uint8Array(50)
		data.fill(66)
		const patchReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'PATCH',
				headers: tusHeaders({
					'Upload-Offset': '0',
					'Content-Type': 'application/offset+octet-stream'
				}),
				body: data
			}
		)
		const res = await server.handle(patchReq)
		expect(res.status).toBe(204)
		expect(res.headers.get('Upload-Offset')).toBe('50')
	})

	it('rejects wrong offset with 409', async () => {
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		const patchReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'PATCH',
				headers: tusHeaders({
					'Upload-Offset': '50',
					'Content-Type': 'application/offset+octet-stream'
				}),
				body: new Uint8Array(10)
			}
		)
		const res = await server.handle(patchReq)
		expect(res.status).toBe(409)
	})

	it('rejects missing Upload-Offset with 403', async () => {
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		const patchReq = new Request(
			`http://localhost:3000/api/uploads/${id}`,
			{
				method: 'PATCH',
				headers: tusHeaders({
					'Content-Type': 'application/offset+octet-stream'
				}),
				body: new Uint8Array(10)
			}
		)
		const res = await server.handle(patchReq)
		expect(res.status).toBe(403)
	})

	it('completes a multi-chunk upload', async () => {
		const createReq = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			}
		)
		const createRes = await server.handle(createReq)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		// First chunk: 60 bytes
		const chunk1 = new Uint8Array(60)
		chunk1.fill(65)
		const res1 = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'PATCH',
					headers: tusHeaders({
						'Upload-Offset': '0',
						'Content-Type':
							'application/offset+octet-stream'
					}),
					body: chunk1
				}
			)
		)
		expect(res1.status).toBe(204)
		expect(res1.headers.get('Upload-Offset')).toBe('60')

		// Second chunk: 40 bytes
		const chunk2 = new Uint8Array(40)
		chunk2.fill(66)
		const res2 = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'PATCH',
					headers: tusHeaders({
						'Upload-Offset': '60',
						'Content-Type':
							'application/offset+octet-stream'
					}),
					body: chunk2
				}
			)
		)
		expect(res2.status).toBe(204)
		expect(res2.headers.get('Upload-Offset')).toBe('100')

		// Verify via HEAD
		const headRes = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'HEAD',
					headers: tusHeaders({})
				}
			)
		)
		expect(headRes.headers.get('Upload-Offset')).toBe('100')
		expect(headRes.headers.get('Upload-Length')).toBe('100')
	})
})

// ── Deferred length ─────────────────────────────────────────────────────────

describe('Deferred length flow', () => {
	it('creates with defer, patches with length declaration, completes', async () => {
		// Create with deferred length
		const createRes = await server.handle(
			new Request('http://localhost:3000/api/uploads', {
				method: 'POST',
				headers: tusHeaders({
					'Upload-Defer-Length': '1'
				})
			})
		)
		expect(createRes.status).toBe(201)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		// PATCH with Upload-Length declaration + data
		const data = new Uint8Array(30)
		data.fill(67)
		const patchRes = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'PATCH',
					headers: tusHeaders({
						'Upload-Offset': '0',
						'Upload-Length': '30',
						'Content-Type':
							'application/offset+octet-stream'
					}),
					body: data
				}
			)
		)
		expect(patchRes.status).toBe(204)
		expect(patchRes.headers.get('Upload-Offset')).toBe('30')

		// Verify via HEAD — should now show Upload-Length, not Upload-Defer-Length
		const headRes = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'HEAD',
					headers: tusHeaders({})
				}
			)
		)
		expect(headRes.headers.get('Upload-Length')).toBe('30')
		expect(
			headRes.headers.get('Upload-Defer-Length')
		).toBeNull()
	})
})

// ── DELETE (termination) ────────────────────────────────────────────────────

describe('DELETE termination', () => {
	it('removes upload and returns 204', async () => {
		const createRes = await server.handle(
			new Request('http://localhost:3000/api/uploads', {
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '50'
				})
			})
		)
		const id = createRes.headers
			.get('Location')!
			.split('/')
			.pop()!

		const deleteRes = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'DELETE',
					headers: tusHeaders({})
				}
			)
		)
		expect(deleteRes.status).toBe(204)

		// Verify gone via HEAD
		const headRes = await server.handle(
			new Request(
				`http://localhost:3000/api/uploads/${id}`,
				{
					method: 'HEAD',
					headers: tusHeaders({})
				}
			)
		)
		expect(headRes.status).toBe(404)
	})
})

// ── Expiration ──────────────────────────────────────────────────────────────

describe('Expiration', () => {
	it('returns Upload-Expires header on create for incomplete uploads', async () => {
		const createRes = await server.handle(
			new Request('http://localhost:3000/api/uploads', {
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			})
		)
		expect(createRes.status).toBe(201)
		expect(
			createRes.headers.get('Upload-Expires')
		).toBeTruthy()
	})

	it('cleanUpExpiredUploads removes expired uploads', async () => {
		// Create a store with very short expiration
		const shortStore = new FileStore({
			directory: tmpDir,
			expirationPeriodInMilliseconds: 1 // 1ms
		})
		const shortServer = new TusServer({
			path: TUS_PATH,
			datastore: shortStore,
			relativeLocation: true
		})

		const createRes = await shortServer.handle(
			new Request('http://localhost:3000/api/uploads', {
				method: 'POST',
				headers: tusHeaders({
					'Upload-Length': '100'
				})
			})
		)
		expect(createRes.status).toBe(201)

		// Wait for expiration
		await new Promise(r => setTimeout(r, 10))

		const count = await shortServer.cleanUpExpiredUploads()
		expect(count).toBe(1)
	})
})

// ── Tus-Resumable enforcement ───────────────────────────────────────────────

describe('Tus-Resumable enforcement', () => {
	it('returns 412 when Tus-Resumable header is missing on non-OPTIONS', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'POST',
				headers: { 'Upload-Length': '100' }
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(412)
	})

	it('does not require Tus-Resumable on OPTIONS', async () => {
		const req = new Request(
			'http://localhost:3000/api/uploads',
			{
				method: 'OPTIONS'
			}
		)
		const res = await server.handle(req)
		expect(res.status).toBe(204)
	})
})
