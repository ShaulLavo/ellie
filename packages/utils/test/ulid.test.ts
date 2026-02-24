import { describe, it, expect } from 'bun:test'
import { ulid } from '../src/ulid'

describe('ulid', () => {
	it('returns a 26-character string', () => {
		const id = ulid()
		expect(typeof id).toBe('string')
		expect(id.length).toBe(26)
	})

	it('only contains Crockford Base32 characters', () => {
		// Crockford Base32: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
		// Excluded: I, L, O, U
		const valid = /^[0-9A-HJKMNP-TV-Z]+$/
		for (let i = 0; i < 100; i++) {
			expect(ulid()).toMatch(valid)
		}
	})

	it('generates unique IDs (1000 IDs)', () => {
		const ids = new Set<string>()
		for (let i = 0; i < 1000; i++) {
			ids.add(ulid())
		}
		expect(ids.size).toBe(1000)
	})

	it('is time-sortable: later IDs sort after earlier ones', async () => {
		const id1 = ulid()
		await new Promise((r) => setTimeout(r, 2))
		const id2 = ulid()
		expect(id2 > id1).toBe(true)
	})

	it('survives batch boundary (>8192 IDs)', () => {
		// Implementation batches 8192 random IDs per crypto.getRandomValues call.
		// Generating more triggers a buffer refill.
		const count = 8200
		const ids = new Set<string>()
		for (let i = 0; i < count; i++) {
			ids.add(ulid())
		}
		expect(ids.size).toBe(count)
	})

	it('first 10 chars encode timestamp, last 16 are random', () => {
		// IDs generated in the same millisecond share the timestamp prefix
		// but differ in the random suffix.
		const ids: string[] = []
		for (let i = 0; i < 100; i++) {
			ids.push(ulid())
		}

		const byPrefix = new Map<string, string[]>()
		for (const id of ids) {
			const prefix = id.slice(0, 10)
			const group = byPrefix.get(prefix) ?? []
			group.push(id)
			byPrefix.set(prefix, group)
		}

		// Tight loop — at least one prefix group should have multiple IDs
		const hasCollision = [...byPrefix.values()].some((g) => g.length > 1)
		expect(hasCollision).toBe(true)

		// Within same-timestamp groups, random suffixes must differ
		for (const group of byPrefix.values()) {
			if (group.length > 1) {
				const suffixes = group.map((id) => id.slice(10))
				const uniqueSuffixes = new Set(suffixes)
				expect(uniqueSuffixes.size).toBe(suffixes.length)
			}
		}
	})
})
