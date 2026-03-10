import { describe, test, expect, mock } from 'bun:test'

// Mock Baileys before importing — mock.module is process-global in Bun,
// so include all exports that other test files (e.g. provider.test.ts) need.
const mockDownload = mock(() =>
	Promise.resolve(Buffer.from('test'))
)
mock.module('@whiskeysockets/baileys', () => ({
	default: () => ({}),
	makeWASocket: () => ({}),
	DisconnectReason: {
		loggedOut: 401,
		connectionReplaced: 440
	},
	fetchLatestBaileysVersion: async () => ({
		version: [2, 3000, 0]
	}),
	makeCacheableSignalKeyStore: (keys: unknown) => keys,
	useMultiFileAuthState: async () => ({
		state: { creds: {}, keys: {} },
		saveCreds: async () => {}
	}),
	downloadMediaMessage: mockDownload
}))

const { downloadInboundMedia } =
	await import('./media-download')

function makeWAMessage(
	messageFields: Record<string, unknown> = {}
) {
	return {
		key: { remoteJid: '123@s.whatsapp.net', id: 'msg1' },
		message: messageFields
	} as never
}

describe('downloadInboundMedia', () => {
	test('returns undefined when no message', async () => {
		const result = await downloadInboundMedia({
			key: { remoteJid: '123@s.whatsapp.net' }
		} as never)
		expect(result).toBeUndefined()
	})

	test('returns undefined when no media in message', async () => {
		const msg = makeWAMessage({ conversation: 'just text' })
		const result = await downloadInboundMedia(msg)
		expect(result).toBeUndefined()
	})

	test('downloads imageMessage with explicit mimetype', async () => {
		mockDownload.mockResolvedValueOnce(
			Buffer.from('image-data')
		)
		const msg = makeWAMessage({
			imageMessage: { mimetype: 'image/png', url: 'x' }
		})
		const result = await downloadInboundMedia(msg)
		expect(result).toBeDefined()
		expect(result!.mimetype).toBe('image/png')
	})

	test('falls back to default mimetype for imageMessage', async () => {
		mockDownload.mockResolvedValueOnce(
			Buffer.from('image-data')
		)
		const msg = makeWAMessage({
			imageMessage: { url: 'x' }
		})
		const result = await downloadInboundMedia(msg)
		expect(result!.mimetype).toBe('image/jpeg')
	})

	test('falls back to default mimetype for audioMessage', async () => {
		mockDownload.mockResolvedValueOnce(Buffer.from('audio'))
		const msg = makeWAMessage({
			audioMessage: { url: 'x' }
		})
		const result = await downloadInboundMedia(msg)
		expect(result!.mimetype).toBe('audio/ogg; codecs=opus')
	})

	test('falls back to default mimetype for stickerMessage', async () => {
		mockDownload.mockResolvedValueOnce(
			Buffer.from('sticker')
		)
		const msg = makeWAMessage({
			stickerMessage: { url: 'x' }
		})
		const result = await downloadInboundMedia(msg)
		expect(result!.mimetype).toBe('image/webp')
	})

	test('extracts fileName from documentMessage', async () => {
		mockDownload.mockResolvedValueOnce(Buffer.from('doc'))
		const msg = makeWAMessage({
			documentMessage: {
				url: 'x',
				mimetype: 'application/pdf',
				fileName: 'report.pdf'
			}
		})
		const result = await downloadInboundMedia(msg)
		expect(result!.fileName).toBe('report.pdf')
		expect(result!.mimetype).toBe('application/pdf')
	})
})
