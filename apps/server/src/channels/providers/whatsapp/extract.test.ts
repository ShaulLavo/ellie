import { describe, test, expect } from 'bun:test'
import {
	extractText,
	extractMediaPlaceholder,
	extractContextInfo,
	extractMentionedJids,
	describeReplyContext,
	extractLocationData,
	formatLocationText
} from './extract'

describe('extractText', () => {
	test('returns null for null message', () => {
		expect(extractText(null)).toBeNull()
		expect(extractText(undefined)).toBeNull()
	})

	test('extracts conversation text', () => {
		expect(extractText({ conversation: 'hello' })).toBe(
			'hello'
		)
	})

	test('extracts extendedTextMessage text', () => {
		expect(
			extractText({
				extendedTextMessage: { text: 'link preview text' }
			})
		).toBe('link preview text')
	})

	test('extracts imageMessage caption', () => {
		expect(
			extractText({
				imageMessage: { caption: 'photo caption' }
			})
		).toBe('photo caption')
	})

	test('extracts videoMessage caption', () => {
		expect(
			extractText({
				videoMessage: { caption: 'video caption' }
			})
		).toBe('video caption')
	})

	test('extracts documentMessage caption', () => {
		expect(
			extractText({
				documentMessage: { caption: 'doc caption' }
			})
		).toBe('doc caption')
	})

	test('extracts single contact placeholder', () => {
		const msg = {
			contactMessage: {
				displayName: 'John',
				vcard:
					'BEGIN:VCARD\nFN:John Smith\nTEL:+15551234567\nEND:VCARD'
			}
		}
		expect(extractText(msg)).toBe(
			'<contact: John Smith, +15551234567>'
		)
	})

	test('extracts contact placeholder without phone', () => {
		const msg = {
			contactMessage: {
				displayName: 'Jane',
				vcard: 'BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD'
			}
		}
		expect(extractText(msg)).toBe('<contact: Jane Doe>')
	})

	test('extracts multiple contacts placeholder', () => {
		const msg = {
			contactsArrayMessage: {
				contacts: [
					{
						displayName: 'Alice',
						vcard: 'BEGIN:VCARD\nFN:Alice A\nEND:VCARD'
					},
					{
						displayName: 'Bob',
						vcard: 'BEGIN:VCARD\nFN:Bob B\nEND:VCARD'
					},
					{
						displayName: 'Carol',
						vcard: 'BEGIN:VCARD\nFN:Carol C\nEND:VCARD'
					}
				]
			}
		}
		expect(extractText(msg)).toBe(
			'<contacts: Alice A, Bob B +1 more>'
		)
	})

	test('extracts single contact from contactsArray', () => {
		const msg = {
			contactsArrayMessage: {
				contacts: [
					{
						displayName: 'Alice',
						vcard:
							'BEGIN:VCARD\nFN:Alice\nTEL:+1555\nEND:VCARD'
					}
				]
			}
		}
		expect(extractText(msg)).toBe('<contact: Alice, +1555>')
	})

	test('returns null for image without caption', () => {
		expect(
			extractText({ imageMessage: { url: 'http://...' } })
		).toBeNull()
	})

	test('returns null for empty message object', () => {
		expect(extractText({})).toBeNull()
	})
})

describe('extractMediaPlaceholder', () => {
	test('returns undefined for null', () => {
		expect(extractMediaPlaceholder(null)).toBeUndefined()
		expect(
			extractMediaPlaceholder(undefined)
		).toBeUndefined()
	})

	test('returns <media:image>', () => {
		expect(
			extractMediaPlaceholder({
				imageMessage: { url: 'x' }
			})
		).toBe('<media:image>')
	})

	test('returns <media:video>', () => {
		expect(
			extractMediaPlaceholder({
				videoMessage: { url: 'x' }
			})
		).toBe('<media:video>')
	})

	test('returns <media:audio>', () => {
		expect(
			extractMediaPlaceholder({
				audioMessage: { url: 'x' }
			})
		).toBe('<media:audio>')
	})

	test('returns <media:document>', () => {
		expect(
			extractMediaPlaceholder({
				documentMessage: { url: 'x' }
			})
		).toBe('<media:document>')
	})

	test('returns <media:sticker>', () => {
		expect(
			extractMediaPlaceholder({
				stickerMessage: { url: 'x' }
			})
		).toBe('<media:sticker>')
	})

	test('returns undefined for text message', () => {
		expect(
			extractMediaPlaceholder({ conversation: 'hi' })
		).toBeUndefined()
	})
})

describe('extractContextInfo', () => {
	test('returns undefined for null', () => {
		expect(extractContextInfo(null)).toBeUndefined()
	})

	test('extracts from extendedTextMessage', () => {
		const msg = {
			extendedTextMessage: {
				text: 'hi',
				contextInfo: {
					mentionedJid: ['123@s.whatsapp.net']
				}
			}
		}
		expect(extractContextInfo(msg)?.mentionedJid).toEqual([
			'123@s.whatsapp.net'
		])
	})

	test('extracts from audioMessage', () => {
		const msg = {
			audioMessage: {
				contextInfo: { participant: '456@s.whatsapp.net' }
			}
		}
		expect(extractContextInfo(msg)?.participant).toBe(
			'456@s.whatsapp.net'
		)
	})

	test('falls back to iterating all fields', () => {
		const msg = {
			someCustomMessage: {
				contextInfo: {
					mentionedJid: ['custom@s.whatsapp.net']
				}
			}
		}
		expect(extractContextInfo(msg)?.mentionedJid).toEqual([
			'custom@s.whatsapp.net'
		])
	})
})

describe('extractMentionedJids (extract.ts)', () => {
	test('returns undefined when no context info', () => {
		expect(
			extractMentionedJids({ conversation: 'hi' })
		).toBeUndefined()
	})

	test('deduplicates JIDs', () => {
		const msg = {
			extendedTextMessage: {
				contextInfo: {
					mentionedJid: [
						'111@s.whatsapp.net',
						'111@s.whatsapp.net',
						'222@s.whatsapp.net'
					]
				}
			}
		}
		expect(extractMentionedJids(msg)).toEqual([
			'111@s.whatsapp.net',
			'222@s.whatsapp.net'
		])
	})
})

describe('describeReplyContext', () => {
	test('returns null when not a reply', () => {
		expect(
			describeReplyContext({ conversation: 'hi' })
		).toBeNull()
	})

	test('returns null when no quotedMessage', () => {
		const msg = {
			extendedTextMessage: {
				contextInfo: { participant: '123@s.whatsapp.net' }
			}
		}
		expect(describeReplyContext(msg)).toBeNull()
	})

	test('extracts reply context with text', () => {
		const msg = {
			extendedTextMessage: {
				text: 'my reply',
				contextInfo: {
					stanzaId: 'MSG123',
					participant: '15551234567@s.whatsapp.net',
					quotedMessage: {
						conversation: 'the original message'
					}
				}
			}
		}
		const ctx = describeReplyContext(msg)
		expect(ctx).not.toBeNull()
		expect(ctx!.id).toBe('MSG123')
		expect(ctx!.body).toBe('the original message')
		expect(ctx!.senderJid).toBe(
			'15551234567@s.whatsapp.net'
		)
		expect(ctx!.senderE164).toBe('+15551234567')
	})

	test('extracts reply context with media placeholder', () => {
		const msg = {
			extendedTextMessage: {
				text: 'replying to image',
				contextInfo: {
					participant: '15559999999@s.whatsapp.net',
					quotedMessage: {
						imageMessage: { url: 'http://...' }
					}
				}
			}
		}
		const ctx = describeReplyContext(msg)
		expect(ctx!.body).toBe('<media:image>')
	})

	test('extracts reply context with location', () => {
		const msg = {
			extendedTextMessage: {
				text: 'saw your location',
				contextInfo: {
					participant: '15559999999@s.whatsapp.net',
					quotedMessage: {
						locationMessage: {
							degreesLatitude: 37.7749,
							degreesLongitude: -122.4194
						}
					}
				}
			}
		}
		const ctx = describeReplyContext(msg)
		expect(ctx!.body).toContain('37.774900')
	})

	test('handles empty quoted message', () => {
		const msg = {
			extendedTextMessage: {
				contextInfo: {
					participant: '15551234567@s.whatsapp.net',
					quotedMessage: {}
				}
			}
		}
		const ctx = describeReplyContext(msg)
		expect(ctx!.body).toBe('')
	})
})

describe('extractLocationData', () => {
	test('returns null for null message', () => {
		expect(extractLocationData(null)).toBeNull()
	})

	test('returns null for text message', () => {
		expect(
			extractLocationData({ conversation: 'hi' })
		).toBeNull()
	})

	test('extracts pin drop', () => {
		const msg = {
			locationMessage: {
				degreesLatitude: 37.7749,
				degreesLongitude: -122.4194
			}
		}
		const loc = extractLocationData(msg)
		expect(loc).not.toBeNull()
		expect(loc!.latitude).toBe(37.7749)
		expect(loc!.longitude).toBe(-122.4194)
		expect(loc!.source).toBe('pin')
		expect(loc!.isLive).toBeUndefined()
	})

	test('extracts place with name and address', () => {
		const msg = {
			locationMessage: {
				degreesLatitude: 37.7749,
				degreesLongitude: -122.4194,
				name: 'Anthropic HQ',
				address: '123 Main St'
			}
		}
		const loc = extractLocationData(msg)
		expect(loc!.source).toBe('place')
		expect(loc!.name).toBe('Anthropic HQ')
		expect(loc!.address).toBe('123 Main St')
	})

	test('extracts live location', () => {
		const msg = {
			liveLocationMessage: {
				degreesLatitude: 37.7749,
				degreesLongitude: -122.4194,
				accuracyInMeters: 10
			}
		}
		const loc = extractLocationData(msg)
		expect(loc!.isLive).toBe(true)
		expect(loc!.source).toBe('live')
		expect(loc!.accuracy).toBe(10)
	})

	test('returns null for invalid coords', () => {
		const msg = {
			locationMessage: {
				degreesLatitude: 'invalid',
				degreesLongitude: -122.4194
			}
		}
		expect(extractLocationData(msg)).toBeNull()
	})
})

describe('formatLocationText', () => {
	test('returns null for null', () => {
		expect(formatLocationText(null)).toBeNull()
	})

	test('formats pin drop', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				source: 'pin'
			})
		).toBe('📍 37.774900, -122.419400')
	})

	test('formats place with name and address', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				name: 'Anthropic HQ',
				address: '123 Main St',
				source: 'place'
			})
		).toBe(
			'📍 Anthropic HQ — 123 Main St (37.774900, -122.419400)'
		)
	})

	test('formats place with name only', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				name: 'Some Place',
				source: 'place'
			})
		).toBe('📍 Some Place (37.774900, -122.419400)')
	})

	test('formats place with address only', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				address: '123 Main St',
				source: 'place'
			})
		).toBe('📍 123 Main St (37.774900, -122.419400)')
	})

	test('formats live location with accuracy', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: 10,
				isLive: true,
				source: 'live'
			})
		).toBe('🛰 Live location: 37.774900, -122.419400 ±10m')
	})

	test('formats live location without accuracy', () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				isLive: true,
				source: 'live'
			})
		).toBe('🛰 Live location: 37.774900, -122.419400')
	})

	test('caption appended on new line', () => {
		const text = formatLocationText({
			latitude: 37.7749,
			longitude: -122.4194,
			source: 'pin',
			caption: 'Meet here'
		})
		expect(text).toContain('37.774900')
		expect(text).toContain('\nMeet here')
	})
})
