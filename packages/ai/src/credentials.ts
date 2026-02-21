/**
 * Credential management for multiple named credentials.
 *
 * Stores credentials in a `.credentials.json` file as a keyed map.
 * Supports any credential type: OAuth, API key, bearer token, basic auth, or custom.
 *
 * File format:
 * ```json
 * {
 *   "anthropic": { "type": "oauth", "access": "...", "refresh": "...", "expires": 123 },
 *   "openai": { "type": "api_key", "key": "sk-..." },
 *   "github": { "type": "bearer_token", "token": "ghp_..." },
 *   "registry": { "type": "basic_auth", "username": "admin", "password": "..." },
 *   "my-service": { "type": "custom", "data": { "whatever": "you want" } }
 * }
 * ```
 *
 * Backward compatible: if the file contains a single credential object
 * (old format with `type` at root), it's migrated to `{ default: <old> }`.
 */

import { chmod } from "node:fs/promises"

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuthCredential {
  type: "oauth"
  access: string
  refresh: string
  expires: number
}

export interface ApiKeyCredential {
  type: "api_key"
  key: string
}

export interface BearerTokenCredential {
  type: "bearer_token"
  token: string
}

export interface BasicAuthCredential {
  type: "basic_auth"
  username: string
  password: string
}

export interface CustomCredential {
  type: "custom"
  data: Record<string, unknown>
}

export type AuthCredential =
  | OAuthCredential
  | ApiKeyCredential
  | BearerTokenCredential
  | BasicAuthCredential
  | CustomCredential

/** The entire credentials file: a map of name → credential */
export type CredentialsStore = Record<string, AuthCredential>

// ── Load / Save ──────────────────────────────────────────────────────────────

/**
 * Check if a parsed object is a single legacy credential (old format).
 */
function isLegacyFormat(json: unknown): json is AuthCredential {
  return (
    typeof json === "object" &&
    json !== null &&
    "type" in json &&
    typeof (json as Record<string, unknown>).type === "string"
  )
}

/**
 * Load all credentials from a JSON file.
 * Returns an empty object if the file doesn't exist or is invalid.
 *
 * Handles backward compatibility: if the file contains a single credential
 * (old format), it's returned as `{ default: <credential> }`.
 */
export async function loadCredentials(
  path: string,
): Promise<CredentialsStore> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  try {
    const json = await file.json()
    if (isLegacyFormat(json)) {
      return { default: json }
    }
    return json as CredentialsStore
  } catch {
    return {}
  }
}

/**
 * Load a single credential by name.
 * Defaults to "default" if no name is provided.
 */
export async function loadCredential(
  path: string,
  name = "default",
): Promise<AuthCredential | null> {
  const store = await loadCredentials(path)
  return store[name] ?? null
}

/**
 * Save the entire credentials store to a JSON file with restrictive permissions.
 */
export async function saveCredentials(
  path: string,
  store: CredentialsStore,
): Promise<void> {
  await Bun.write(path, JSON.stringify(store, null, 2))
  try {
    await chmod(path, 0o600)
  } catch {
    // chmod may fail on Windows — not critical
  }
}

/**
 * Save a single credential by name.
 * Merges with existing credentials in the file.
 */
export async function saveCredential(
  path: string,
  name: string,
  credential: AuthCredential,
): Promise<void> {
  const store = await loadCredentials(path)
  store[name] = credential
  await saveCredentials(path, store)
}

/**
 * Remove a credential by name.
 * Returns true if the credential existed and was removed.
 */
export async function removeCredential(
  path: string,
  name: string,
): Promise<boolean> {
  const store = await loadCredentials(path)
  if (!(name in store)) return false
  delete store[name]
  await saveCredentials(path, store)
  return true
}

/**
 * List all credential names in the file.
 */
export async function listCredentials(path: string): Promise<string[]> {
  const store = await loadCredentials(path)
  return Object.keys(store)
}

