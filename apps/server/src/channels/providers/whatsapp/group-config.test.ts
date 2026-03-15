import { describe, test, expect } from 'bun:test'
import {
	resolveGroupConfig,
	resolveRequireMention,
	resolveToolsBySender,
	resolveGroupToolsPolicy,
	type WhatsAppGroupConfig
} from './group-config'

describe('resolveGroupConfig', () => {
	test('returns exact group match', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { requireMention: false },
			'*': { requireMention: true }
		}
		expect(resolveGroupConfig(groups, '123@g.us')).toEqual({
			requireMention: false
		})
	})

	test('falls back to wildcard when no exact match', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'*': { requireMention: false }
		}
		expect(
			resolveGroupConfig(groups, 'unknown@g.us')
		).toEqual({ requireMention: false })
	})

	test('exact match takes precedence over wildcard', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { requireMention: false },
			'*': { requireMention: true }
		}
		const config = resolveGroupConfig(groups, '123@g.us')
		expect(config?.requireMention).toBe(false)
	})

	test('returns undefined when no match and no wildcard', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'other@g.us': { requireMention: false }
		}
		expect(
			resolveGroupConfig(groups, 'unknown@g.us')
		).toBeUndefined()
	})

	test('returns undefined for empty groups map', () => {
		expect(
			resolveGroupConfig({}, '123@g.us')
		).toBeUndefined()
	})
})

describe('resolveRequireMention', () => {
	test('returns exact match requireMention=false', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { requireMention: false }
		}
		expect(resolveRequireMention(groups, '123@g.us')).toBe(
			false
		)
	})

	test('returns wildcard requireMention=false', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'*': { requireMention: false }
		}
		expect(resolveRequireMention(groups, 'any@g.us')).toBe(
			false
		)
	})

	test('defaults to true when no match', () => {
		expect(resolveRequireMention({}, 'unknown@g.us')).toBe(
			true
		)
	})

	test('defaults to true when config exists but requireMention undefined', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': {}
		}
		expect(resolveRequireMention(groups, '123@g.us')).toBe(
			true
		)
	})

	test('exact match overrides wildcard', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { requireMention: false },
			'*': { requireMention: true }
		}
		expect(resolveRequireMention(groups, '123@g.us')).toBe(
			false
		)
		expect(
			resolveRequireMention(groups, 'other@g.us')
		).toBe(true)
	})
})

describe('resolveToolsBySender', () => {
	test('matches by senderId', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'+15551234567': 'none',
				'+15559999999': 'all'
			},
			senderId: '+15551234567'
		})
		expect(result).toBe('none')
	})

	test('matches by senderE164', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'+15551234567': 'none'
			},
			senderE164: '+15551234567'
		})
		expect(result).toBe('none')
	})

	test('matches by senderName', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				alice: { allow: ['search'] }
			},
			senderName: 'Alice'
		})
		expect(result).toEqual({ allow: ['search'] })
	})

	test('strips @ prefix from keys', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'@alice': 'none'
			},
			senderName: 'alice'
		})
		expect(result).toBe('none')
	})

	test('case-insensitive matching', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'+15551234567': 'all'
			},
			senderId: '+15551234567'
		})
		expect(result).toBe('all')
	})

	test('falls back to wildcard "*"', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'+15551234567': 'none',
				'*': 'all'
			},
			senderId: '+19999999999'
		})
		expect(result).toBe('all')
	})

	test('returns undefined when no match and no wildcard', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				'+15551234567': 'none'
			},
			senderId: '+19999999999'
		})
		expect(result).toBeUndefined()
	})

	test('returns undefined when toolsBySender is undefined', () => {
		expect(
			resolveToolsBySender({
				senderId: '+15551234567'
			})
		).toBeUndefined()
	})

	test('returns undefined when toolsBySender is empty', () => {
		expect(
			resolveToolsBySender({
				toolsBySender: {},
				senderId: '+15551234567'
			})
		).toBeUndefined()
	})

	test('tries senderId before senderE164 before senderName', () => {
		const result = resolveToolsBySender({
			toolsBySender: {
				alice: { allow: ['web'] },
				'+15551234567': { deny: ['web'] }
			},
			senderId: '+15551234567',
			senderName: 'Alice'
		})
		// senderId matches first
		expect(result).toEqual({ deny: ['web'] })
	})
})

describe('resolveGroupToolsPolicy', () => {
	test('uses group-specific tools', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { tools: 'none' }
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: '123@g.us'
		})
		expect(result).toBe('none')
	})

	test('uses group-specific toolsBySender over tools', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': {
				tools: 'all',
				toolsBySender: {
					'+15551234567': 'none'
				}
			}
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: '123@g.us',
			senderId: '+15551234567'
		})
		expect(result).toBe('none')
	})

	test('falls back from group toolsBySender miss to group tools', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': {
				tools: { deny: ['web'] },
				toolsBySender: {
					'+15551234567': 'none'
				}
			}
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: '123@g.us',
			senderId: '+19999999999'
		})
		expect(result).toEqual({ deny: ['web'] })
	})

	test('falls back to default "*" tools', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'*': { tools: 'all' }
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: 'unknown@g.us'
		})
		expect(result).toBe('all')
	})

	test('falls back to default "*" toolsBySender', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'*': {
				toolsBySender: {
					'+15551234567': 'none'
				}
			}
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: 'unknown@g.us',
			senderId: '+15551234567'
		})
		expect(result).toBe('none')
	})

	test('group-specific sender policy beats default tools', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': {
				toolsBySender: {
					'+15551234567': 'none'
				}
			},
			'*': { tools: 'all' }
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: '123@g.us',
			senderId: '+15551234567'
		})
		expect(result).toBe('none')
	})

	test('returns undefined when no config', () => {
		const result = resolveGroupToolsPolicy({
			groups: {},
			groupJid: '123@g.us'
		})
		expect(result).toBeUndefined()
	})

	test('returns undefined when group has no tools config', () => {
		const groups: Record<string, WhatsAppGroupConfig> = {
			'123@g.us': { requireMention: false }
		}
		const result = resolveGroupToolsPolicy({
			groups,
			groupJid: '123@g.us'
		})
		expect(result).toBeUndefined()
	})
})
