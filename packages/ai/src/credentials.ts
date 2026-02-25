/**
 * Credential loading for multi-provider authentication.
 *
 * Supports two formats:
 * 1. Legacy single-provider: { type: "oauth", ... } or { type: "api_key", key: "..." }
 * 2. Multi-provider: { anthropic: { type: "oauth", ... }, groq: { type: "api_key", key: "..." } }
 *
 * Anthropic credential shapes (persisted):
 *   API key:  { "type": "api_key", "key": "..." }
 *   Token:    { "type": "token", "token": "...", "expires"?: number }
 *   OAuth:    { "type": "oauth", "access": "...", "refresh": "...", "expires": number }
 *
 * Legacy field aliases accepted on read:
 *   access_token → access, refresh_token → refresh, expires_at → expires
 */

import { chmod } from 'node:fs/promises'

/**
 * Legacy OAuth credential shape used by the old bot-repo provider format.
 * New code should prefer NormalizedOAuthCredential (short field names:
 * access, refresh, expires) which is what auth routes write to disk.
 */
export interface OAuthCredential {
	type: 'oauth'
	access_token: string
	refresh_token: string
	expires_at: number
	client_id: string
	client_secret: string
}

export interface ApiKeyCredential {
	type: 'api_key'
	key: string
}

export interface TokenCredential {
	type: 'token'
	token: string
	expires?: number
}

/**
 * Normalized anthropic credential shape used by auth routes.
 * Uses short field names (access, refresh, expires).
 */
export type NormalizedOAuthCredential = {
	type: 'oauth'
	access: string
	refresh: string
	expires: number
}

export type AnthropicCredential =
	| ApiKeyCredential
	| TokenCredential
	| NormalizedOAuthCredential

export type AuthCredential =
	| OAuthCredential
	| ApiKeyCredential

export type CredentialMap = Record<string, unknown>

function isMultiProvider(
	json: unknown
): json is Record<string, unknown> {
	return (
		typeof json === 'object' &&
		json !== null &&
		!('type' in json)
	)
}

/**
 * Normalize a raw anthropic credential object, accepting legacy field aliases.
 * Accepts: access/access_token, refresh/refresh_token, expires/expires_at.
 */
export function normalizeAnthropicCredential(
	raw: Record<string, unknown>
): AnthropicCredential | null {
	const type = raw.type
	if (type === 'api_key' && typeof raw.key === 'string') {
		return { type: 'api_key', key: raw.key }
	}
	if (type === 'token' && typeof raw.token === 'string') {
		const expires =
			typeof raw.expires === 'number'
				? raw.expires
				: undefined
		return { type: 'token', token: raw.token, expires }
	}
	if (type === 'oauth') {
		const access =
			typeof raw.access === 'string'
				? raw.access
				: typeof raw.access_token === 'string'
					? raw.access_token
					: null
		const refresh =
			typeof raw.refresh === 'string'
				? raw.refresh
				: typeof raw.refresh_token === 'string'
					? raw.refresh_token
					: null
		const expires =
			typeof raw.expires === 'number'
				? raw.expires
				: typeof raw.expires_at === 'number'
					? raw.expires_at
					: null
		if (access && refresh && expires !== null) {
			return {
				type: 'oauth',
				access,
				refresh,
				expires
			}
		}
	}
	return null
}

/**
 * Load the entire credential map from a multi-provider file.
 * Returns null if file doesn't exist or is not valid JSON.
 * Returns the raw parsed JSON object.
 */
export async function loadCredentialMap(
	path: string
): Promise<CredentialMap | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	try {
		const json = await file.json()
		if (typeof json !== 'object' || json === null)
			return null
		return json as CredentialMap
	} catch {
		return null
	}
}

/**
 * Read the normalized anthropic credential from the credential map.
 * Handles legacy field aliases.
 */
export async function loadAnthropicCredential(
	path: string
): Promise<AnthropicCredential | null> {
	const map = await loadCredentialMap(path)
	if (!map) return null

	// Multi-provider format: look under "anthropic" key
	if (isMultiProvider(map)) {
		const raw = map.anthropic
		if (raw && typeof raw === 'object' && 'type' in raw) {
			return normalizeAnthropicCredential(
				raw as Record<string, unknown>
			)
		}
		return null
	}

	// Legacy single-provider format
	return normalizeAnthropicCredential(
		map as Record<string, unknown>
	)
}

/**
 * Set the anthropic credential in the credential map file.
 * Preserves all other provider entries.
 * Creates the file if it doesn't exist.
 * Returns an error message if the file contains invalid JSON.
 *
 * Note: the read-modify-write is not atomic. This is intentional —
 * this is a single-user local config file and concurrent writers
 * are not a realistic concern.
 */
export async function setAnthropicCredential(
	path: string,
	credential: AnthropicCredential
): Promise<{ ok: true } | { ok: false; error: string }> {
	const file = Bun.file(path)
	let map: CredentialMap = {}

	if (await file.exists()) {
		try {
			const raw = await file.text()
			const parsed = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null) {
				return {
					ok: false,
					error:
						'Credentials file is not a valid JSON object. Fix or delete the file manually.'
				}
			}
			map = parsed as CredentialMap
		} catch {
			return {
				ok: false,
				error:
					'Credentials file contains invalid JSON. Fix or delete the file manually.'
			}
		}
	}

	map.anthropic = credential
	await Bun.write(path, JSON.stringify(map, null, 2) + '\n')
	try {
		await chmod(path, 0o600)
	} catch {
		// chmod may fail on some platforms; best-effort
	}
	return { ok: true }
}

/**
 * Remove only the anthropic key from the credential map.
 * Preserves all other entries. Returns whether anything was removed.
 */
export async function clearAnthropicCredential(
	path: string
): Promise<boolean> {
	const file = Bun.file(path)
	if (!(await file.exists())) return false

	try {
		const raw = await file.text()
		const parsed = JSON.parse(raw)
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			!('anthropic' in parsed)
		) {
			return false
		}
		const map = parsed as CredentialMap
		delete map.anthropic
		await Bun.write(
			path,
			JSON.stringify(map, null, 2) + '\n'
		)
		try {
			await chmod(path, 0o600)
		} catch {
			// best-effort
		}
		return true
	} catch {
		return false
	}
}

/**
 * Load a specific provider's credential from a credentials file.
 *
 * Handles both multi-provider and legacy single-provider formats.
 * For multi-provider files, extracts the named provider's credential.
 * For legacy files, returns the credential regardless of provider name.
 */
export async function loadProviderCredential(
	path: string,
	provider: string
): Promise<AuthCredential | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	try {
		const json = await file.json()
		if (isMultiProvider(json)) {
			const cred = json[provider]
			if (
				cred &&
				typeof cred === 'object' &&
				'type' in cred
			) {
				return cred as AuthCredential
			}
			return null
		}
		// Legacy single-provider format
		return json as AuthCredential
	} catch {
		return null
	}
}

/**
 * Load a credential from a legacy single-provider file.
 *
 * Returns null for multi-provider files (use loadProviderCredential instead).
 */
export async function loadCredential(
	path: string
): Promise<AuthCredential | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	try {
		const json = await file.json()
		if (isMultiProvider(json)) return null
		return json as AuthCredential
	} catch {
		return null
	}
}
