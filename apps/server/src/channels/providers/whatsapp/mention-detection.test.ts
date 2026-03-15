import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	extractMentionedJids,
	extractReplyToSenderJid,
	checkBotMention
} from './mention-detection'

describe('extractMentionedJids', () => {
	test('extracts from extendedTextMessage', () => {
		const msg = {
			extendedTextMessage: {
				text: 'hello @bot',
				contextInfo: {
					mentionedJid: ['15550001111@s.whatsapp.net']
				}
			}
		}
		expect(extractMentionedJids(msg)).toEqual([
			'15550001111@s.whatsapp.net'
		])
	})

	test('extracts from imageMessage', () => {
		const msg = {
			imageMessage: {
				caption: 'look @bot',
				contextInfo: {
					mentionedJid: ['15550001111@s.whatsapp.net']
				}
			}
		}
		expect(extractMentionedJids(msg)).toEqual([
			'15550001111@s.whatsapp.net'
		])
	})

	test('extracts from videoMessage', () => {
		const msg = {
			videoMessage: {
				contextInfo: {
					mentionedJid: ['15550001111@s.whatsapp.net']
				}
			}
		}
		expect(extractMentionedJids(msg)).toEqual([
			'15550001111@s.whatsapp.net'
		])
	})

	test('deduplicates JIDs', () => {
		const msg = {
			extendedTextMessage: {
				contextInfo: {
					mentionedJid: [
						'15550001111@s.whatsapp.net',
						'15550001111@s.whatsapp.net',
						'15550002222@s.whatsapp.net'
					]
				}
			}
		}
		expect(extractMentionedJids(msg)).toEqual([
			'15550001111@s.whatsapp.net',
			'15550002222@s.whatsapp.net'
		])
	})

	test('returns undefined for no mentions', () => {
		const msg = {
			extendedTextMessage: {
				text: 'hello',
				contextInfo: { mentionedJid: [] }
			}
		}
		expect(extractMentionedJids(msg)).toBeUndefined()
	})

	test('returns undefined for null message', () => {
		expect(extractMentionedJids(null)).toBeUndefined()
		expect(extractMentionedJids(undefined)).toBeUndefined()
	})

	test('returns undefined for plain conversation message', () => {
		const msg = { conversation: 'hello' }
		expect(extractMentionedJids(msg)).toBeUndefined()
	})
})

describe('extractReplyToSenderJid', () => {
	test('extracts participant from quoted message', () => {
		const msg = {
			extendedTextMessage: {
				contextInfo: {
					participant: '15550001111@s.whatsapp.net'
				}
			}
		}
		expect(extractReplyToSenderJid(msg)).toBe(
			'15550001111@s.whatsapp.net'
		)
	})

	test('returns undefined for no reply', () => {
		const msg = {
			extendedTextMessage: {
				text: 'hello',
				contextInfo: {}
			}
		}
		expect(extractReplyToSenderJid(msg)).toBeUndefined()
	})

	test('returns undefined for null message', () => {
		expect(extractReplyToSenderJid(null)).toBeUndefined()
	})
})

describe('checkBotMention', () => {
	const selfJid = '15550001111@s.whatsapp.net'
	const selfE164 = '+15550001111'

	test('detects explicit @mention by JID', () => {
		const result = checkBotMention({
			mentionedJids: ['15550001111@s.whatsapp.net'],
			selfJid,
			selfE164,
			replyToSenderJid: undefined,
			body: 'hey @bot'
		})
		expect(result.wasMentioned).toBe(true)
		expect(result.implicitMention).toBe(false)
	})

	test('detects @mention with device suffix stripping', () => {
		const result = checkBotMention({
			mentionedJids: ['15550001111:5@s.whatsapp.net'],
			selfJid: '15550001111:0@s.whatsapp.net',
			selfE164,
			replyToSenderJid: undefined,
			body: 'hey @bot'
		})
		expect(result.wasMentioned).toBe(true)
	})

	test('detects @mention by E.164 fallback', () => {
		const result = checkBotMention({
			// Mentioned JID resolves to same E.164
			mentionedJids: ['15550001111@s.whatsapp.net'],
			selfJid: '99999@s.whatsapp.net', // different raw JID
			selfE164,
			replyToSenderJid: undefined,
			body: 'hey'
		})
		expect(result.wasMentioned).toBe(true)
	})

	test('detects reply-to-self as implicit mention', () => {
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid,
			selfE164,
			replyToSenderJid: '15550001111@s.whatsapp.net',
			body: 'thanks for that'
		})
		expect(result.wasMentioned).toBe(false)
		expect(result.implicitMention).toBe(true)
	})

	test('detects reply-to-self with device suffix', () => {
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid: '15550001111:0@s.whatsapp.net',
			selfE164,
			replyToSenderJid: '15550001111:3@s.whatsapp.net',
			body: 'reply'
		})
		expect(result.implicitMention).toBe(true)
	})

	test('detects reply-to-self via E.164 match', () => {
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid: '99999@s.whatsapp.net', // doesn't match directly
			selfE164,
			// Reply-to JID resolves to same E.164
			replyToSenderJid: '15550001111@s.whatsapp.net',
			body: 'reply'
		})
		expect(result.implicitMention).toBe(true)
	})

	test('detects body text containing phone digits', () => {
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid,
			selfE164,
			replyToSenderJid: undefined,
			body: 'call 15550001111 please'
		})
		expect(result.wasMentioned).toBe(true)
	})

	test('no mention, no reply — both false', () => {
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid,
			selfE164,
			replyToSenderJid: undefined,
			body: 'hello everyone'
		})
		expect(result.wasMentioned).toBe(false)
		expect(result.implicitMention).toBe(false)
	})

	test('no mention when selfJid is null', () => {
		const result = checkBotMention({
			mentionedJids: ['15550001111@s.whatsapp.net'],
			selfJid: null,
			selfE164: null,
			replyToSenderJid: undefined,
			body: 'hey'
		})
		expect(result.wasMentioned).toBe(false)
		expect(result.implicitMention).toBe(false)
	})

	test('both explicit and implicit can be true simultaneously', () => {
		const result = checkBotMention({
			mentionedJids: ['15550001111@s.whatsapp.net'],
			selfJid,
			selfE164,
			replyToSenderJid: '15550001111@s.whatsapp.net',
			body: '@bot'
		})
		expect(result.wasMentioned).toBe(true)
		expect(result.implicitMention).toBe(true)
	})

	test('mentioned in quoted message (not direct) is not a mention', () => {
		// Bot's JID appears only in quotedMessage, not in mentionedJid
		const result = checkBotMention({
			mentionedJids: undefined,
			selfJid,
			selfE164,
			replyToSenderJid: undefined,
			body: 'some random text'
		})
		expect(result.wasMentioned).toBe(false)
		expect(result.implicitMention).toBe(false)
	})

	test('partial phone match in mentionedJid is not a mention', () => {
		// mentionedJid has a JID that is a prefix of selfE164 but not exact
		const result = checkBotMention({
			mentionedJids: ['1555123@s.whatsapp.net'],
			selfJid: '15551234567@s.whatsapp.net',
			selfE164: '+15551234567',
			replyToSenderJid: undefined,
			body: 'hello'
		})
		expect(result.wasMentioned).toBe(false)
	})

	describe('LID resolution via authDir', () => {
		let authDir: string

		beforeEach(() => {
			authDir = mkdtempSync(
				join(tmpdir(), 'wa-mention-lid-test-')
			)
		})

		afterEach(() => {
			rmSync(authDir, {
				recursive: true,
				force: true
			})
		})

		test('LID in mentionedJid matches self when resolved via authDir', () => {
			// Create LID reverse mapping
			writeFileSync(
				join(
					authDir,
					'lid-mapping-118696035008721_reverse.json'
				),
				JSON.stringify('15550001111')
			)

			const result = checkBotMention({
				mentionedJids: ['118696035008721@lid'],
				selfJid,
				selfE164,
				replyToSenderJid: undefined,
				body: 'hello',
				jidOpts: { authDir }
			})
			expect(result.wasMentioned).toBe(true)
		})
	})
})
