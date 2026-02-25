/**
 * Tests for the scoping module: derivation, resolution, and matching.
 */

import { describe, it, expect } from 'bun:test'
import {
	deriveScopeTagsFromContext,
	resolveScope,
	scopeMatches,
	DEFAULT_PROFILE,
	DEFAULT_PROJECT
} from '../scope'

describe('deriveScopeTagsFromContext', () => {
	it('returns defaults when no context provided', () => {
		const scope = deriveScopeTagsFromContext()
		expect(scope.profile).toBe(DEFAULT_PROFILE)
		expect(scope.project).toBe(DEFAULT_PROJECT)
		expect(scope.session).toBeUndefined()
	})

	it('returns defaults when context has empty strings', () => {
		const scope = deriveScopeTagsFromContext({ profile: '', project: '' })
		expect(scope.profile).toBe(DEFAULT_PROFILE)
		expect(scope.project).toBe(DEFAULT_PROJECT)
	})

	it('uses provided profile and project', () => {
		const scope = deriveScopeTagsFromContext({
			profile: 'alice',
			project: 'my-project',
			session: 'sess-1'
		})
		expect(scope.profile).toBe('alice')
		expect(scope.project).toBe('my-project')
		expect(scope.session).toBe('sess-1')
	})

	it('fills in defaults for partial context', () => {
		const scope = deriveScopeTagsFromContext({ profile: 'alice' })
		expect(scope.profile).toBe('alice')
		expect(scope.project).toBe(DEFAULT_PROJECT)
	})
})

describe('resolveScope', () => {
	it('uses explicit scope when fully provided', () => {
		const scope = resolveScope(
			{ profile: 'explicit-profile', project: 'explicit-project' },
			{ profile: 'ctx-profile', project: 'ctx-project' }
		)
		expect(scope.profile).toBe('explicit-profile')
		expect(scope.project).toBe('explicit-project')
	})

	it('merges explicit with context when explicit is partial', () => {
		const scope = resolveScope(
			{ profile: 'explicit-profile' },
			{ profile: 'ctx-profile', project: 'ctx-project' }
		)
		expect(scope.profile).toBe('explicit-profile')
		// project not in explicit, falls through to derived from context
		expect(scope.project).toBe('ctx-project')
	})

	it('uses context when no explicit scope', () => {
		const scope = resolveScope(undefined, {
			profile: 'ctx-profile',
			project: 'ctx-project'
		})
		expect(scope.profile).toBe('ctx-profile')
		expect(scope.project).toBe('ctx-project')
	})

	it('uses defaults when nothing provided', () => {
		const scope = resolveScope()
		expect(scope.profile).toBe(DEFAULT_PROFILE)
		expect(scope.project).toBe(DEFAULT_PROJECT)
	})

	it('carries session from context when explicit has none', () => {
		const scope = resolveScope({ profile: 'p', project: 'proj' }, { session: 'sess-1' })
		expect(scope.session).toBe('sess-1')
	})

	it('explicit session overrides context session', () => {
		const scope = resolveScope(
			{ profile: 'p', project: 'proj', session: 'explicit-sess' },
			{ session: 'ctx-sess' }
		)
		expect(scope.session).toBe('explicit-sess')
	})
})

describe('scopeMatches', () => {
	it('matches when memory scope matches filter scope (strict)', () => {
		expect(
			scopeMatches(
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'alice', project: 'proj-a' },
				'strict'
			)
		).toBe(true)
	})

	it('does not match when profile differs (strict)', () => {
		expect(
			scopeMatches(
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'bob', project: 'proj-a' },
				'strict'
			)
		).toBe(false)
	})

	it('does not match when project differs (strict)', () => {
		expect(
			scopeMatches(
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'alice', project: 'proj-b' },
				'strict'
			)
		).toBe(false)
	})

	it('allows broad mode to match anything', () => {
		expect(
			scopeMatches(
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'bob', project: 'proj-b' },
				'broad'
			)
		).toBe(true)
	})

	it('includes legacy memories with null scope (strict)', () => {
		expect(
			scopeMatches(
				{ profile: null, project: null },
				{ profile: 'alice', project: 'proj-a' },
				'strict'
			)
		).toBe(true)
	})

	it('defaults to strict mode', () => {
		expect(
			scopeMatches({ profile: 'alice', project: 'proj-a' }, { profile: 'bob', project: 'proj-a' })
		).toBe(false)
	})

	it('matches when memory has profile but no project (legacy partial)', () => {
		expect(
			scopeMatches(
				{ profile: 'alice', project: null },
				{ profile: 'alice', project: 'proj-a' },
				'strict'
			)
		).toBe(true)
	})

	it('matches when memory has project but no profile (legacy partial)', () => {
		expect(
			scopeMatches(
				{ profile: null, project: 'proj-a' },
				{ profile: 'user-x', project: 'proj-a' },
				'strict'
			)
		).toBe(true)
	})
})
