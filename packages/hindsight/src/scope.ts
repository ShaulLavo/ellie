/**
 * Scoping ergonomics for preventing cross-project memory bleed.
 *
 * Scope precedence:
 * 1. Explicit `scope` from caller
 * 2. Derived from context (profile, git root/project, session)
 * 3. Fallback defaults: profile="default", project="default"
 */

export interface Scope {
	profile: string
	project: string
	session?: string
}

export interface ScopeContext {
	profile?: string
	project?: string
	session?: string
}

export type ScopeMode = 'strict' | 'broad'

export const DEFAULT_PROFILE = 'default'
export const DEFAULT_PROJECT = 'default'

/**
 * Derive scope tags from a context, applying defaults where missing.
 *
 * Scope precedence:
 * - explicit scope from caller overrides everything
 * - fallback defaults: profile="default", project="default"
 */
export function deriveScopeTagsFromContext(
	ctx?: ScopeContext
): Scope {
	return {
		profile: ctx?.profile || DEFAULT_PROFILE,
		project: ctx?.project || DEFAULT_PROJECT,
		session: ctx?.session
	}
}

/**
 * Resolve the effective scope for an operation, with explicit scope taking precedence.
 */
export function resolveScope(
	explicit?: Partial<Scope>,
	context?: ScopeContext
): Scope {
	if (explicit?.profile && explicit?.project) {
		return {
			profile: explicit.profile,
			project: explicit.project,
			session: explicit.session ?? context?.session
		}
	}
	const derived = deriveScopeTagsFromContext(context)
	return {
		profile: explicit?.profile || derived.profile,
		project: explicit?.project || derived.project,
		session: explicit?.session ?? derived.session
	}
}

/**
 * Check if two scope tags match (for filtering).
 *
 * In strict mode (default): both profile and project must match.
 * In broad mode: returns true (no scope filtering).
 */
export function scopeMatches(
	memoryScope: {
		profile: string
		project: string
	},
	filterScope: Scope,
	mode: ScopeMode = 'strict'
): boolean {
	if (mode === 'broad') return true

	return (
		memoryScope.profile === filterScope.profile &&
		memoryScope.project === filterScope.project
	)
}
