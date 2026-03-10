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
	resolveParticipantJid,
	isLidJid,
	lidBaseNumber,
	readSelfId,
	normalizeWhatsAppTarget,
	isWhatsAppGroupJid,
	isWhatsAppUserTarget
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

	test('broadcast returns null', () => {
		expect(jidToE164('status@broadcast')).toBeNull()
	})

	test('empty string returns null', () => {
		expect(jidToE164('')).toBeNull()
	})

	// ── @hosted user JIDs ────────────────────────────────────────

	test('@hosted user JID extracts E.164', () => {
		expect(jidToE164('15550001111@hosted')).toBe(
			'+15550001111'
		)
	})

	test('@hosted JID with device suffix', () => {
		expect(jidToE164('15550001111:0@hosted')).toBe(
			'+15550001111'
		)
	})

	// ── LID fallback (matching OpenCLAW) ─────────────────────────

	test('LID JID without authDir falls back to digits as E.164', () => {
		expect(jidToE164('118696035008721@lid')).toBe(
			'+118696035008721'
		)
	})

	test('hosted.lid without authDir falls back to digits as E.164', () => {
		expect(jidToE164('118696035008721@hosted.lid')).toBe(
			'+118696035008721'
		)
	})

	test('hosted.lid with device suffix falls back to digits', () => {
		expect(jidToE164('118696035008721:5@hosted.lid')).toBe(
			'+118696035008721'
		)
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

		test('falls back to LID digits when mapping file missing', () => {
			expect(jidToE164('999999999@lid', { authDir })).toBe(
				'+999999999'
			)
		})

		test('falls back to LID digits when mapping file has null', () => {
			writeFileSync(
				join(authDir, 'lid-mapping-555_reverse.json'),
				JSON.stringify(null)
			)
			expect(jidToE164('555@lid', { authDir })).toBe('+555')
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

		test('resolves hosted.lid via reverse mapping', () => {
			writeFileSync(
				join(
					authDir,
					'lid-mapping-118696035008721_reverse.json'
				),
				JSON.stringify('41796666864')
			)
			expect(
				jidToE164('118696035008721@hosted.lid', {
					authDir
				})
			).toBe('+41796666864')
		})

		test('resolves hosted.lid with device suffix via reverse mapping', () => {
			writeFileSync(
				join(
					authDir,
					'lid-mapping-118696035008721_reverse.json'
				),
				JSON.stringify('41796666864')
			)
			expect(
				jidToE164('118696035008721:5@hosted.lid', {
					authDir
				})
			).toBe('+41796666864')
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

	test('hosted.lid', () => {
		expect(isLidJid('118696035008721@hosted.lid')).toBe(
			true
		)
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

describe('resolveParticipantJid', () => {
	test('returns E.164 for standard user JID', () => {
		expect(
			resolveParticipantJid('15550001111@s.whatsapp.net')
		).toBe('+15550001111')
	})

	test('returns E.164 for user JID with device suffix', () => {
		expect(
			resolveParticipantJid('15550001111:5@s.whatsapp.net')
		).toBe('+15550001111')
	})

	test('returns E.164 for @hosted JID', () => {
		expect(
			resolveParticipantJid('15550001111@hosted')
		).toBe('+15550001111')
	})

	test('falls back to raw JID for group JID', () => {
		expect(resolveParticipantJid('12345-67890@g.us')).toBe(
			'12345-67890@g.us'
		)
	})

	test('returns E.164 fallback for LID JID', () => {
		expect(resolveParticipantJid('999999@lid')).toBe(
			'+999999'
		)
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

	test('hosted.lid', () => {
		expect(
			lidBaseNumber('118696035008721@hosted.lid')
		).toBe('118696035008721')
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

// ── isWhatsAppGroupJid ──────────────────────────────────────────────

describe('isWhatsAppGroupJid', () => {
	test('numeric group JID', () => {
		expect(isWhatsAppGroupJid('120363123456@g.us')).toBe(
			true
		)
	})

	test('group JID with dashes', () => {
		expect(isWhatsAppGroupJid('12345-67890@g.us')).toBe(
			true
		)
	})

	test('strips whatsapp: prefix', () => {
		expect(
			isWhatsAppGroupJid('whatsapp:120363123456@g.us')
		).toBe(true)
	})

	test('rejects user JID', () => {
		expect(
			isWhatsAppGroupJid('15550001111@s.whatsapp.net')
		).toBe(false)
	})

	test('rejects alpha group JID', () => {
		expect(isWhatsAppGroupJid('abc@g.us')).toBe(false)
	})
})

// ── isWhatsAppUserTarget ────────────────────────────────────────────

describe('isWhatsAppUserTarget', () => {
	test('standard user JID', () => {
		expect(
			isWhatsAppUserTarget('15550001111@s.whatsapp.net')
		).toBe(true)
	})

	test('user JID with device suffix', () => {
		expect(
			isWhatsAppUserTarget('15550001111:0@s.whatsapp.net')
		).toBe(true)
	})

	test('@lid JID', () => {
		expect(
			isWhatsAppUserTarget('118696035008721@lid')
		).toBe(true)
	})

	test('@hosted JID', () => {
		expect(isWhatsAppUserTarget('15550001111@hosted')).toBe(
			true
		)
	})

	test('@hosted.lid JID', () => {
		expect(
			isWhatsAppUserTarget('118696035008721@hosted.lid')
		).toBe(true)
	})

	test('rejects group JID', () => {
		expect(isWhatsAppUserTarget('12345-67890@g.us')).toBe(
			false
		)
	})

	test('rejects unknown domain', () => {
		expect(isWhatsAppUserTarget('user@unknown.com')).toBe(
			false
		)
	})

	test('rejects bare phone', () => {
		expect(isWhatsAppUserTarget('+15550001111')).toBe(false)
	})
})

// ── normalizeWhatsAppTarget ─────────────────────────────────────────

describe('normalizeWhatsAppTarget', () => {
	test('bare phone → E.164', () => {
		expect(normalizeWhatsAppTarget('15550001111')).toBe(
			'+15550001111'
		)
	})

	test('E.164 with plus', () => {
		expect(normalizeWhatsAppTarget('+15550001111')).toBe(
			'+15550001111'
		)
	})

	test('strips whatsapp: prefix', () => {
		expect(
			normalizeWhatsAppTarget('whatsapp:+15550001111')
		).toBe('+15550001111')
	})

	test('group JID passthrough', () => {
		expect(
			normalizeWhatsAppTarget('12345-67890@g.us')
		).toBe('12345-67890@g.us')
	})

	test('numeric group JID passthrough', () => {
		expect(
			normalizeWhatsAppTarget('120363123456@g.us')
		).toBe('120363123456@g.us')
	})

	test('invalid group JID (letters)', () => {
		expect(normalizeWhatsAppTarget('abc@g.us')).toBeNull()
	})

	test('user JID → E.164', () => {
		expect(
			normalizeWhatsAppTarget('15550001111@s.whatsapp.net')
		).toBe('+15550001111')
	})

	test('user JID with device suffix → E.164', () => {
		expect(
			normalizeWhatsAppTarget(
				'15550001111:0@s.whatsapp.net'
			)
		).toBe('+15550001111')
	})

	test('LID JID → E.164 (matching OpenCLAW)', () => {
		expect(
			normalizeWhatsAppTarget('118696035008721@lid')
		).toBe('+118696035008721')
	})

	test('hosted.lid JID → E.164', () => {
		expect(
			normalizeWhatsAppTarget('118696035008721@hosted.lid')
		).toBe('+118696035008721')
	})

	test('@hosted user JID → E.164', () => {
		expect(
			normalizeWhatsAppTarget('15550001111@hosted')
		).toBe('+15550001111')
	})

	test('@hosted with device suffix → E.164', () => {
		expect(
			normalizeWhatsAppTarget('15550001111:0@hosted')
		).toBe('+15550001111')
	})

	test('LID with device suffix → E.164', () => {
		expect(
			normalizeWhatsAppTarget('118696035008721:5@lid')
		).toBe('+118696035008721')
	})

	test('strips double whatsapp: prefix', () => {
		expect(
			normalizeWhatsAppTarget(
				'whatsapp:whatsapp:+15550001111'
			)
		).toBe('+15550001111')
	})

	test('whitespace-only returns null', () => {
		expect(normalizeWhatsAppTarget('   ')).toBeNull()
	})

	test('rejects unknown @ format', () => {
		expect(
			normalizeWhatsAppTarget('user@unknown.com')
		).toBeNull()
	})

	test('rejects empty string', () => {
		expect(normalizeWhatsAppTarget('')).toBeNull()
	})
})

// ── readSelfId ──────────────────────────────────────────────────────

describe('readSelfId', () => {
	let authDir: string

	beforeEach(() => {
		authDir = mkdtempSync(join(tmpdir(), 'wa-selfid-test-'))
	})

	afterEach(() => {
		rmSync(authDir, { recursive: true, force: true })
	})

	test('reads E.164 and JID from creds.json', () => {
		writeFileSync(
			join(authDir, 'creds.json'),
			JSON.stringify({
				me: { id: '15550001111:0@s.whatsapp.net' }
			})
		)
		const result = readSelfId(authDir)
		expect(result.e164).toBe('+15550001111')
		expect(result.jid).toBe('15550001111:0@s.whatsapp.net')
	})

	test('returns null when creds.json missing', () => {
		const result = readSelfId(authDir)
		expect(result.e164).toBeNull()
		expect(result.jid).toBeNull()
	})

	test('returns null when creds.me.id missing', () => {
		writeFileSync(
			join(authDir, 'creds.json'),
			JSON.stringify({ me: {} })
		)
		const result = readSelfId(authDir)
		expect(result.e164).toBeNull()
	})

	test('handles creds with LID — resolves via reverse mapping', () => {
		writeFileSync(
			join(authDir, 'creds.json'),
			JSON.stringify({
				me: { id: '118696035008721@lid' }
			})
		)
		writeFileSync(
			join(
				authDir,
				'lid-mapping-118696035008721_reverse.json'
			),
			JSON.stringify('41796666864')
		)
		const result = readSelfId(authDir)
		expect(result.e164).toBe('+41796666864')
		expect(result.jid).toBe('118696035008721@lid')
	})

	test('handles creds with LID — fallback to digits when no mapping', () => {
		writeFileSync(
			join(authDir, 'creds.json'),
			JSON.stringify({
				me: { id: '118696035008721@lid' }
			})
		)
		const result = readSelfId(authDir)
		// readSelfId passes authDir to jidToE164, and LID fallback returns digits
		expect(result.e164).toBe('+118696035008721')
		expect(result.jid).toBe('118696035008721@lid')
	})
})
