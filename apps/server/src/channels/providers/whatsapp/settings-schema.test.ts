import { describe, test, expect } from 'bun:test'
import * as v from 'valibot'
import { whatsappSettingsSchema } from './settings-schema'

describe('whatsappSettingsSchema', () => {
	test('accepts valid minimal settings (empty object)', () => {
		const result = v.safeParse(whatsappSettingsSchema, {})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.output.dmPolicy).toBe('pairing')
			expect(result.output.selfChatMode).toBe(false)
			expect(result.output.allowFrom).toEqual([])
			expect(result.output.groupPolicy).toBe('disabled')
			expect(result.output.groupAllowFrom).toEqual([])
			expect(result.output.groups).toEqual({})
			expect(result.output.sendReadReceipts).toBe(true)
			expect(result.output.debounceMs).toBe(0)
			expect(result.output.mediaMaxMb).toBe(50)
			expect(result.output.historyLimit).toBe(50)
		}
	})

	test('accepts full valid settings', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			selfChatMode: true,
			dmPolicy: 'allowlist',
			allowFrom: ['+15551234567'],
			groupPolicy: 'open',
			groupAllowFrom: ['+15559876543'],
			groups: {
				'123@g.us': { requireMention: false },
				'*': { requireMention: true }
			},
			sendReadReceipts: false,
			debounceMs: 2000,
			mediaMaxMb: 25,
			historyLimit: 100
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.output.selfChatMode).toBe(true)
			expect(result.output.dmPolicy).toBe('allowlist')
			expect(result.output.sendReadReceipts).toBe(false)
			expect(result.output.debounceMs).toBe(2000)
			expect(result.output.groups['123@g.us']).toEqual({
				requireMention: false
			})
		}
	})

	test('fills defaults for partial settings', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			dmPolicy: 'pairing'
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.output.selfChatMode).toBe(false)
			expect(result.output.sendReadReceipts).toBe(true)
			expect(result.output.mediaMaxMb).toBe(50)
			expect(result.output.historyLimit).toBe(50)
			expect(result.output.groups).toEqual({})
		}
	})

	test('rejects dmPolicy "open" without "*" in allowFrom', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			dmPolicy: 'open',
			allowFrom: ['+15551234567']
		})
		expect(result.success).toBe(false)
	})

	test('accepts dmPolicy "open" with "*" in allowFrom', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			dmPolicy: 'open',
			allowFrom: ['*']
		})
		expect(result.success).toBe(true)
	})

	test('rejects invalid dmPolicy', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			dmPolicy: 'invalid'
		})
		expect(result.success).toBe(false)
	})

	test('rejects invalid groupPolicy', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groupPolicy: 'invalid'
		})
		expect(result.success).toBe(false)
	})

	test('rejects negative debounceMs', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			debounceMs: -100
		})
		expect(result.success).toBe(false)
	})

	test('rejects zero mediaMaxMb', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			mediaMaxMb: 0
		})
		expect(result.success).toBe(false)
	})

	test('rejects negative historyLimit', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			historyLimit: -1
		})
		expect(result.success).toBe(false)
	})

	test('accepts historyLimit of 0 (disables history)', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			historyLimit: 0
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.output.historyLimit).toBe(0)
		}
	})

	test('handles pre-Phase6 settings (backward compat)', () => {
		// Simulate old settings that only had the basic fields
		const result = v.safeParse(whatsappSettingsSchema, {
			selfChatMode: false,
			dmPolicy: 'allowlist',
			allowFrom: ['+15551234567'],
			groupPolicy: 'disabled'
		})
		expect(result.success).toBe(true)
		if (result.success) {
			// New fields should have defaults
			expect(result.output.groupAllowFrom).toEqual([])
			expect(result.output.groups).toEqual({})
			expect(result.output.sendReadReceipts).toBe(true)
			expect(result.output.debounceMs).toBe(0)
			expect(result.output.mediaMaxMb).toBe(50)
			expect(result.output.historyLimit).toBe(50)
		}
	})

	test('accepts groups with requireMention only', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': { requireMention: false }
			}
		})
		expect(result.success).toBe(true)
	})

	test('accepts groups with tools policy string', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': { tools: 'none' },
				'*': { tools: 'all' }
			}
		})
		expect(result.success).toBe(true)
	})

	test('accepts groups with tools policy object', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': {
					tools: {
						allow: ['search', 'weather'],
						deny: ['admin']
					}
				}
			}
		})
		expect(result.success).toBe(true)
	})

	test('accepts groups with toolsBySender', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': {
					requireMention: false,
					tools: 'all',
					toolsBySender: {
						'+15551234567': 'none',
						'*': { allow: ['search'] }
					}
				}
			}
		})
		expect(result.success).toBe(true)
	})

	test('accepts empty group config object', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: { '123@g.us': {} }
		})
		expect(result.success).toBe(true)
	})

	test('rejects invalid tools policy value', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': { tools: 'invalid' }
			}
		})
		expect(result.success).toBe(false)
	})

	test('rejects invalid toolsBySender value', () => {
		const result = v.safeParse(whatsappSettingsSchema, {
			groups: {
				'123@g.us': {
					toolsBySender: {
						'+15551234567': 'invalid'
					}
				}
			}
		})
		expect(result.success).toBe(false)
	})
})
