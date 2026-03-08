/**
 * Credential loading for multi-provider authentication.
 *
 * Supports two formats:
 * 1. Legacy single-provider: { type: "oauth", ... } or { type: "api_key", key: "..." }
 * 2. Multi-provider: { anthropic: { ... }, groq: { ... } }
 *
 * Anthropic credential shapes (persisted):
 *   API key:  { "type": "api_key", "key": "..." }
 *   Token:    { "type": "token", "token": "...", "expires"?: number }
 *   OAuth:    { "type": "oauth", "access": "...", "refresh": "...", "expires": number }
 *
 * Groq credential shapes (persisted):
 *   API key:  { "type": "api_key", "key": "..." }
 *
 * Legacy field aliases accepted on read:
 *   access_token → access, refresh_token → refresh, expires_at → expires
 */

import { chmod } from 'node:fs/promises'

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

/** Groq only supports API key authentication. */
export type GroqCredential = ApiKeyCredential

/** Brave Search only supports API key authentication. */
export type BraveCredential = ApiKeyCredential

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

// ── Generic provider credential ops ──────────────────────────────────────────

/**
 * Load an API-key-only provider credential from the multi-provider map.
 */
async function loadApiKeyProvider(
	path: string,
	providerKey: string
): Promise<ApiKeyCredential | null> {
	const map = await loadCredentialMap(path)
	if (!map) return null
	if (!isMultiProvider(map)) return null

	const raw = map[providerKey]
	if (
		raw &&
		typeof raw === 'object' &&
		'type' in raw &&
		(raw as Record<string, unknown>).type === 'api_key' &&
		'key' in raw &&
		typeof (raw as Record<string, unknown>).key === 'string'
	) {
		return {
			type: 'api_key',
			key: (raw as Record<string, unknown>).key as string
		}
	}
	return null
}

/**
 * Read and validate an existing credential map file.
 * Returns the parsed map, or an error result if the file is invalid.
 */
async function readExistingCredentialMap(
	path: string
): Promise<
	| { ok: true; map: CredentialMap }
	| { ok: false; error: string }
> {
	const file = Bun.file(path)
	if (!(await file.exists())) return { ok: true, map: {} }

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
		return { ok: true, map: parsed as CredentialMap }
	} catch {
		return {
			ok: false,
			error:
				'Credentials file contains invalid JSON. Fix or delete the file manually.'
		}
	}
}

/**
 * Set a provider credential in the credential map file.
 * Preserves all other provider entries.
 *
 * Note: the read-modify-write is not atomic. This is intentional —
 * this is a single-user local config file and concurrent writers
 * are not a realistic concern.
 */
async function setProviderCredential(
	path: string,
	providerKey: string,
	credential: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await readExistingCredentialMap(path)
	if (!result.ok) return result

	const map = result.map
	map[providerKey] = credential
	await Bun.write(path, JSON.stringify(map, null, 2) + '\n')
	try {
		await chmod(path, 0o600)
	} catch {
		// chmod may fail on some platforms; best-effort
	}
	return { ok: true }
}

/**
 * Remove a provider key from the credential map.
 * Preserves all other entries. Returns whether anything was removed.
 */
async function clearProviderCredential(
	path: string,
	providerKey: string
): Promise<boolean> {
	const file = Bun.file(path)
	if (!(await file.exists())) return false

	try {
		const raw = await file.text()
		const parsed = JSON.parse(raw)
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			!(providerKey in parsed)
		) {
			return false
		}
		const map = parsed as CredentialMap
		delete map[providerKey]
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

// ── Provider-specific exports ────────────────────────────────────────────────

export const loadGroqCredential = (path: string) =>
	loadApiKeyProvider(path, 'groq')

export const loadBraveCredential = (path: string) =>
	loadApiKeyProvider(path, 'brave')

export const setGroqCredential = (
	path: string,
	credential: GroqCredential
) => setProviderCredential(path, 'groq', credential)

export const setBraveCredential = (
	path: string,
	credential: BraveCredential
) => setProviderCredential(path, 'brave', credential)

export const setAnthropicCredential = (
	path: string,
	credential: AnthropicCredential
) => setProviderCredential(path, 'anthropic', credential)

export const clearGroqCredential = (path: string) =>
	clearProviderCredential(path, 'groq')

export const clearBraveCredential = (path: string) =>
	clearProviderCredential(path, 'brave')

export const clearAnthropicCredential = (path: string) =>
	clearProviderCredential(path, 'anthropic')
