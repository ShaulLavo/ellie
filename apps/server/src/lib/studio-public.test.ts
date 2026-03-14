import { describe, expect, it } from 'bun:test'
import { resolveStudioPublic } from './studio-public'

describe('resolveStudioPublic', () => {
	it('uses the explicit env override first', () => {
		const result = resolveStudioPublic({
			candidates: ['/tmp/web-dist', '/tmp/web'],
			env: {
				ELLIE_STUDIO_PUBLIC: '/tmp/custom-web',
				NODE_ENV: 'production'
			},
			pathExists: () => true
		})

		expect(result).toEqual({
			dir: '/tmp/custom-web',
			source: 'env'
		})
	})

	it('uses the first candidate that exists', () => {
		const result = resolveStudioPublic({
			candidates: [
				'/tmp/bundle-web',
				'/tmp/web-dist',
				'/tmp/web'
			],
			env: {},
			pathExists: path => path === '/tmp/web-dist'
		})

		expect(result).toEqual({
			dir: '/tmp/web-dist',
			source: 'found'
		})
	})

	it('falls back to last candidate when none exist', () => {
		const result = resolveStudioPublic({
			candidates: [
				'/tmp/bundle-web',
				'/tmp/web-dist',
				'/tmp/web'
			],
			env: {},
			pathExists: () => false
		})

		expect(result).toEqual({
			dir: '/tmp/web',
			source: 'fallback'
		})
	})
})
