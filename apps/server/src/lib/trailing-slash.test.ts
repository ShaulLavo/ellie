import { describe, expect, test } from 'bun:test'
import {
	getTrailingSlashRedirectUrl,
	normalizeTrailingSlashPath
} from './trailing-slash'

describe('normalizeTrailingSlashPath', () => {
	test('keeps root path unchanged', () => {
		expect(normalizeTrailingSlashPath('/')).toBe('/')
	})

	test('removes a single trailing slash', () => {
		expect(normalizeTrailingSlashPath('/app/')).toBe('/app')
	})

	test('collapses multiple trailing slashes', () => {
		expect(normalizeTrailingSlashPath('/app///')).toBe(
			'/app'
		)
	})
})

describe('getTrailingSlashRedirectUrl', () => {
	test('returns null when url is already canonical', () => {
		expect(
			getTrailingSlashRedirectUrl(
				'http://localhost:3000/app'
			)
		).toBeNull()
	})

	test('preserves query params while removing trailing slash', () => {
		expect(
			getTrailingSlashRedirectUrl(
				'http://localhost:3000/app/?tab=chat'
			)
		).toBe('http://localhost:3000/app?tab=chat')
	})
})
