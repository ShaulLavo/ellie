import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import {
	normalizeE164,
	toWhatsAppJid,
	jidToE164,
	isLidJid,
	lidBaseNumber
} from './normalize'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('normalizeE164', () => {
	test('digits without plus get plus prefix', () => {
		expect(normalizeE164('15550001111')).toBe(
			'+15550001111'
		)
	})

	test('already has plus prefix', () => {
		expect(normalizeE164('+15550001111')).toBe(
			'+15550001111'
		)
	})

	test('strips spaces, parens, dashes', () => {
		expect(normalizeE164('+1 (555) 000-1111')).toBe(
			'+15550001111'
		)
	})

	test('strips whatsapp: prefix', () => {
		expect(normalizeE164('whatsapp:+15550001111')).toBe(
			'+15550001111'
		)
	})

	test('handles leading/trailing whitespace', () => {
		expect(normalizeE164('  +15550001111  ')).toBe(
			'+15550001111'
		)
	})

	test('swiss number', () => {
		expect(normalizeE164('+41 79 666 68 64')).toBe(
			'+41796666864'
		)
	})
})

describe('toWhatsAppJid', () => {
	test('E.164 to JID', () => {
		expect(toWhatsAppJid('+15550001111')).toBe(
			'15550001111@s.whatsapp.net'
		)
	})

	test('bare digits to JID', () => {
		expect(toWhatsAppJid('15550001111')).toBe(
			'15550001111@s.whatsapp.net'
		)
	})

	test('already a JID — returns as-is', () => {
		expect(
			toWhatsAppJid('15550001111@s.whatsapp.net')
		).toBe('15550001111@s.whatsapp.net')
	})

	test('formatted number to JID', () => {
		expect(toWhatsAppJid('+1 (555) 000-1111')).toBe(
			'15550001111@s.whatsapp.net'
		)
	})
})

describe('jidToE164', () => {
	test('standard user JID', () => {
		expect(jidToE164('15550001111@s.whatsapp.net')).toBe(
			'+15550001111'
		)
	})

	test('JID with device suffix', () => {
		expect(jidToE164('15550001111:0@s.whatsapp.net')).toBe(
			'+15550001111'
		)
	})

	test('group JID returns null', () => {
		expect(jidToE164('12345-67890@g.us')).toBeNull()
	})

	test('LID JID without authDir returns null', () => {
		expect(jidToE164('118696035008721@lid')).toBeNull()
	})

	test('broadcast returns null', () => {
		expect(jidToE164('status@broadcast')).toBeNull()
	})

	test('empty string returns null', () => {
		expect(jidToE164('')).toBeNull()
	})

	// ── LID resolution via auth dir (matching openclaw) ──────────

	describe('with authDir (LID reverse mapping)', () => {
		let authDir: string

		beforeEach(() => {
			authDir = mkdtempSync(
				join(tmpdir(), 'wa-normalize-test-')
			)
		})

		afterEach(() => {
			rmSync(authDir, {
				recursive: true,
				force: true
			})
		})

		test('resolves LID via reverse mapping file', () => {
			// Baileys stores: lid-mapping-{lid}_reverse.json containing the phone digits
			writeFileSync(
				join(
					authDir,
					'lid-mapping-118696035008721_reverse.json'
				),
				JSON.stringify('41796666864')
			)
			expect(
				jidToE164('118696035008721@lid', {
					authDir
				})
			).toBe('+41796666864')
		})

		test('resolves LID with device suffix', () => {
			writeFileSync(
				join(
					authDir,
					'lid-mapping-118696035008721_reverse.json'
				),
				JSON.stringify('41796666864')
			)
			expect(
				jidToE164('118696035008721:5@lid', {
					authDir
				})
			).toBe('+41796666864')
		})

		test('returns null when mapping file missing', () => {
			expect(
				jidToE164('999999999@lid', { authDir })
			).toBeNull()
		})

		test('returns null when mapping file has null', () => {
			writeFileSync(
				join(authDir, 'lid-mapping-555_reverse.json'),
				JSON.stringify(null)
			)
			expect(jidToE164('555@lid', { authDir })).toBeNull()
		})

		test('handles numeric value in mapping file', () => {
			writeFileSync(
				join(authDir, 'lid-mapping-777_reverse.json'),
				JSON.stringify(15550001111)
			)
			expect(jidToE164('777@lid', { authDir })).toBe(
				'+15550001111'
			)
		})
	})
})

describe('isLidJid', () => {
	test('standard LID JID', () => {
		expect(isLidJid('118696035008721@lid')).toBe(true)
	})

	test('LID with device suffix', () => {
		expect(isLidJid('118696035008721:5@lid')).toBe(true)
	})

	test('user JID is not LID', () => {
		expect(isLidJid('15550001111@s.whatsapp.net')).toBe(
			false
		)
	})

	test('group JID is not LID', () => {
		expect(isLidJid('12345-67890@g.us')).toBe(false)
	})

	test('empty string', () => {
		expect(isLidJid('')).toBe(false)
	})
})

describe('lidBaseNumber', () => {
	test('standard LID JID', () => {
		expect(lidBaseNumber('118696035008721@lid')).toBe(
			'118696035008721'
		)
	})

	test('LID with device suffix — strips it', () => {
		expect(lidBaseNumber('118696035008721:5@lid')).toBe(
			'118696035008721'
		)
	})

	test('non-LID returns null', () => {
		expect(
			lidBaseNumber('15550001111@s.whatsapp.net')
		).toBeNull()
	})

	test('empty string returns null', () => {
		expect(lidBaseNumber('')).toBeNull()
	})
})
