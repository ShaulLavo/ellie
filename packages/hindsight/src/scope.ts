/**
 * Scoping ergonomics for preventing cross-project memory bleed.
 *
 * Scope precedence:
 * 1. Explicit `scope` from caller
 * 2. Derived from context (profile, git root/project, session)
 * 3. Fallback defaults: profile="default", project="default"
 */

// ── Types ───────────────────────────────────────────────────────────────────

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

export type ScopeMode = "strict" | "broad"

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_PROFILE = "default"
export const DEFAULT_PROJECT = "default"

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Derive scope tags from a context, applying defaults where missing.
 *
 * Scope precedence:
 * - explicit scope from caller overrides everything
 * - fallback defaults: profile="default", project="default"
 */
export function deriveScopeTagsFromContext(ctx?: ScopeContext): Scope {
  return {
    profile: ctx?.profile || DEFAULT_PROFILE,
    project: ctx?.project || DEFAULT_PROJECT,
    session: ctx?.session,
  }
}

/**
 * Resolve the effective scope for an operation, with explicit scope taking precedence.
 */
export function resolveScope(
  explicit?: Partial<Scope>,
  context?: ScopeContext,
): Scope {
  if (explicit?.profile && explicit?.project) {
    return {
      profile: explicit.profile,
      project: explicit.project,
      session: explicit.session ?? context?.session,
    }
  }
  const derived = deriveScopeTagsFromContext(context)
  return {
    profile: explicit?.profile || derived.profile,
    project: explicit?.project || derived.project,
    session: explicit?.session ?? derived.session,
  }
}

/**
 * Check if two scope tags match (for filtering).
 *
 * In strict mode (default): both profile and project must match.
 * In broad mode: returns true (no scope filtering).
 */
export function scopeMatches(
  memoryScope: { profile: string | null; project: string | null },
  filterScope: Scope,
  mode: ScopeMode = "strict",
): boolean {
  if (mode === "broad") return true

  // If memory has no scope tags, include it (legacy data)
  if (!memoryScope.profile && !memoryScope.project) return true

  const profileMatch =
    !memoryScope.profile ||
    memoryScope.profile === filterScope.profile
  const projectMatch =
    !memoryScope.project ||
    memoryScope.project === filterScope.project

  return profileMatch && projectMatch
}
