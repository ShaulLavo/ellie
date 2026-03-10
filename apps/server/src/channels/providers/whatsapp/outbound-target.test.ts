import { describe, test, expect } from 'bun:test'
import { resolveOutboundTarget } from './outbound-target'

describe('resolveOutboundTarget', () => {
	// ── Basic normalization ──────────────────────────────────────────

	test('normalizes bare phone to E.164', () => {
		const result = resolveOutboundTarget({
			to: '15550001111'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('normalizes E.164 with plus', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('strips whatsapp: prefix', () => {
		const result = resolveOutboundTarget({
			to: 'whatsapp:+15550001111'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('passes through group JID', () => {
		const result = resolveOutboundTarget({
			to: '120363123456@g.us'
		})
		expect(result).toEqual({
			ok: true,
			to: '120363123456@g.us'
		})
	})

	test('passes through group JID with dash', () => {
		const result = resolveOutboundTarget({
			to: '12345-67890@g.us'
		})
		expect(result).toEqual({
			ok: true,
			to: '12345-67890@g.us'
		})
	})

	test('normalizes user JID to E.164', () => {
		const result = resolveOutboundTarget({
			to: '15550001111@s.whatsapp.net'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('strips device suffix from user JID', () => {
		const result = resolveOutboundTarget({
			to: '15550001111:0@s.whatsapp.net'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('normalizes LID JID to E.164', () => {
		const result = resolveOutboundTarget({
			to: '118696035008721@lid'
		})
		expect(result).toEqual({
			ok: true,
			to: '+118696035008721'
		})
	})

	test('normalizes @hosted user JID to E.164', () => {
		const result = resolveOutboundTarget({
			to: '15550001111@hosted'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('normalizes @hosted.lid to E.164', () => {
		const result = resolveOutboundTarget({
			to: '118696035008721@hosted.lid'
		})
		expect(result).toEqual({
			ok: true,
			to: '+118696035008721'
		})
	})

	// ── Invalid targets ──────────────────────────────────────────────

	test('rejects empty string', () => {
		const result = resolveOutboundTarget({ to: '' })
		expect(result.ok).toBe(false)
	})

	test('rejects unknown @ format', () => {
		const result = resolveOutboundTarget({
			to: 'user@unknown.com'
		})
		expect(result.ok).toBe(false)
	})

	test('rejects invalid group JID', () => {
		const result = resolveOutboundTarget({
			to: 'abc@g.us'
		})
		expect(result.ok).toBe(false)
	})

	// ── Mode-aware allowlist checks ─────────────────────────────────

	test('explicit mode allows any normalized target', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'explicit',
			allowFrom: ['+19990009999']
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('implicit mode blocks target not in allowFrom', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'implicit',
			allowFrom: ['+19990009999']
		})
		expect(result.ok).toBe(false)
	})

	test('implicit mode allows target in allowFrom', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'implicit',
			allowFrom: ['+15550001111']
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('implicit mode allows wildcard', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'implicit',
			allowFrom: ['*']
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('implicit mode normalizes allowFrom entries for comparison', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'implicit',
			allowFrom: ['15550001111'] // without + prefix
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('group JIDs bypass allowlist check in implicit mode', () => {
		const result = resolveOutboundTarget({
			to: '12345-67890@g.us',
			mode: 'implicit',
			allowFrom: ['+19990009999']
		})
		expect(result).toEqual({
			ok: true,
			to: '12345-67890@g.us'
		})
	})

	// ── OpenCLAW behavior: empty/missing allowFrom allows any target ──

	test('implicit mode: empty allowFrom allows any target (OpenCLAW)', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			allowFrom: [],
			mode: 'implicit'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('implicit mode: no allowFrom allows any target (OpenCLAW)', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'implicit'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('heartbeat mode: no allowFrom allows any target (OpenCLAW)', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'heartbeat'
		})
		expect(result).toEqual({ ok: true, to: '+15550001111' })
	})

	test('heartbeat mode: target in allowFrom is allowed', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'heartbeat',
			allowFrom: ['+15550001111']
		})
		expect(result).toEqual({
			ok: true,
			to: '+15550001111'
		})
	})

	test('heartbeat mode: wildcard allows any target', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'heartbeat',
			allowFrom: ['*']
		})
		expect(result).toEqual({
			ok: true,
			to: '+15550001111'
		})
	})

	test('explicit mode: allows any valid target regardless of allowFrom', () => {
		const result = resolveOutboundTarget({
			to: '+15550001111',
			mode: 'explicit',
			allowFrom: ['+19990009999']
		})
		expect(result).toEqual({
			ok: true,
			to: '+15550001111'
		})
	})
})
