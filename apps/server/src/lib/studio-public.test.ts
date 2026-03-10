import { describe, expect, it } from 'bun:test'
import { resolveStudioPublic } from './studio-public'

describe('resolveStudioPublic', () => {
	it('uses the explicit env override first', () => {
		const result = resolveStudioPublic({
			env: {
				ELLIE_STUDIO_PUBLIC: '/tmp/custom-web',
				NODE_ENV: 'production'
			},
			pathExists: () => false
		})

		expect(result).toEqual({
			dir: '/tmp/custom-web',
			publicDir: null,
			source: 'env'
		})
	})

	it('uses the bundled frontend in production when present', () => {
		const result = resolveStudioPublic({
			env: { NODE_ENV: 'production' },
			bundledDir: '/tmp/web-dist',
			devDir: '/tmp/web-public',
			pathExists: path => path === '/tmp/web-dist'
		})

		expect(result).toEqual({
			dir: '/tmp/web-dist',
			publicDir: null,
			source: 'bundle'
		})
	})

	it('falls back to the dev frontend in production when no bundle exists', () => {
		const result = resolveStudioPublic({
			env: { NODE_ENV: 'production' },
			bundledDir: '/tmp/web-dist',
			devDir: '/tmp/web-public',
			pathExists: () => false
		})

		expect(result).toEqual({
			dir: '/tmp/web-public',
			publicDir: null,
			source: 'dev-fallback'
		})
	})

	it('uses the dev frontend outside production', () => {
		const result = resolveStudioPublic({
			env: { NODE_ENV: 'development' },
			bundledDir: '/tmp/web-dist',
			devDir: '/tmp/web-public',
			pathExists: path => path === '/tmp/web-dist'
		})

		expect(result).toEqual({
			dir: '/tmp/web-public',
			publicDir: null,
			source: 'dev'
		})
	})
})
