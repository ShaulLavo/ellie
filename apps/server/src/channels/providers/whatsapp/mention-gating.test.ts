import { describe, test, expect } from 'bun:test'
import { resolveMentionGating } from './mention-gating'

describe('resolveMentionGating', () => {
	test('requireMention=true + mentioned → shouldProcess', () => {
		const result = resolveMentionGating({
			requireMention: true,
			wasMentioned: true,
			implicitMention: false
		})
		expect(result.shouldProcess).toBe(true)
		expect(result.effectiveWasMentioned).toBe(true)
	})

	test('requireMention=true + not mentioned → skip', () => {
		const result = resolveMentionGating({
			requireMention: true,
			wasMentioned: false,
			implicitMention: false
		})
		expect(result.shouldProcess).toBe(false)
		expect(result.effectiveWasMentioned).toBe(false)
	})

	test('requireMention=false → always process', () => {
		const result = resolveMentionGating({
			requireMention: false,
			wasMentioned: false,
			implicitMention: false
		})
		expect(result.shouldProcess).toBe(true)
		expect(result.effectiveWasMentioned).toBe(false)
	})

	test('implicit mention counts as mentioned', () => {
		const result = resolveMentionGating({
			requireMention: true,
			wasMentioned: false,
			implicitMention: true
		})
		expect(result.shouldProcess).toBe(true)
		expect(result.effectiveWasMentioned).toBe(true)
	})

	test('both explicit and implicit → process', () => {
		const result = resolveMentionGating({
			requireMention: true,
			wasMentioned: true,
			implicitMention: true
		})
		expect(result.shouldProcess).toBe(true)
		expect(result.effectiveWasMentioned).toBe(true)
	})
})
