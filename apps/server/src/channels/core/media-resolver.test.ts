import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { resolveMedia } from './media-resolver'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	mkdirSync
} from 'fs'

describe('resolveMedia', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(
			join(tmpdir(), 'media-resolver-test-')
		)
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	test('resolves local MP3 file', async () => {
		const filePath = join(dir, 'test.mp3')
		writeFileSync(filePath, 'fake-mp3-data')

		const result = await resolveMedia(filePath, {
			localRoots: [dir]
		})

		expect(result.mimetype).toBe('audio/mpeg')
		expect(result.kind).toBe('audio')
		expect(result.fileName).toBe('test.mp3')
		expect(result.buffer.toString()).toBe('fake-mp3-data')
	})

	test('resolves local PNG file', async () => {
		const filePath = join(dir, 'test.png')
		writeFileSync(filePath, 'fake-png')

		const result = await resolveMedia(filePath, {
			localRoots: [dir]
		})

		expect(result.mimetype).toBe('image/png')
		expect(result.kind).toBe('image')
	})

	test('resolves opus file', async () => {
		const filePath = join(dir, 'voice.opus')
		writeFileSync(filePath, 'fake-opus')

		const result = await resolveMedia(filePath, {
			localRoots: [dir]
		})

		expect(result.mimetype).toBe('audio/ogg; codecs=opus')
		expect(result.kind).toBe('audio')
	})

	test('rejects path outside localRoots', async () => {
		expect(
			resolveMedia('/etc/passwd', { localRoots: [dir] })
		).rejects.toThrow('path outside allowed roots')
	})

	test('rejects symlink traversal outside roots', async () => {
		const linkPath = join(dir, 'link')
		try {
			symlinkSync('/etc/hosts', linkPath)
		} catch {
			// Skip on systems where symlink fails
			return
		}

		expect(
			resolveMedia(linkPath, { localRoots: [dir] })
		).rejects.toThrow('path outside allowed roots')
	})

	test('rejects file exceeding maxBytes', async () => {
		const filePath = join(dir, 'big.mp3')
		// Write a buffer just over the limit
		writeFileSync(filePath, new Uint8Array(1024))

		expect(
			resolveMedia(filePath, {
				localRoots: [dir],
				maxBytes: 512
			})
		).rejects.toThrow('exceeds limit')
	})

	test('throws ENOENT for missing file', async () => {
		expect(
			resolveMedia(join(dir, 'nonexistent.mp3'), {
				localRoots: [dir]
			})
		).rejects.toThrow()
	})

	test('unknown extension returns octet-stream and document kind', async () => {
		const filePath = join(dir, 'test.xyz')
		writeFileSync(filePath, 'unknown')

		const result = await resolveMedia(filePath, {
			localRoots: [dir]
		})

		expect(result.mimetype).toBe('application/octet-stream')
		expect(result.kind).toBe('document')
	})

	test('custom localRoots work', async () => {
		const customDir = join(dir, 'uploads')
		mkdirSync(customDir)
		const filePath = join(customDir, 'doc.pdf')
		writeFileSync(filePath, 'fake-pdf')

		const result = await resolveMedia(filePath, {
			localRoots: [customDir]
		})

		expect(result.mimetype).toBe('application/pdf')
		expect(result.kind).toBe('document')
		expect(result.fileName).toBe('doc.pdf')
	})

	test('defaults to tmpdir as localRoot', async () => {
		// dir is already under tmpdir, so default roots should work
		const filePath = join(dir, 'default.wav')
		writeFileSync(filePath, 'fake-wav')

		const result = await resolveMedia(filePath)

		expect(result.mimetype).toBe('audio/wav')
		expect(result.kind).toBe('audio')
	})

	test('video file classification', async () => {
		const filePath = join(dir, 'clip.mp4')
		writeFileSync(filePath, 'fake-video')

		const result = await resolveMedia(filePath, {
			localRoots: [dir]
		})

		expect(result.mimetype).toBe('video/mp4')
		expect(result.kind).toBe('video')
	})
})
