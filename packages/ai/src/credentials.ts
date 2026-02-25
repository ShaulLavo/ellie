/**
 * Credential loading for multi-provider authentication.
 *
 * Supports two formats:
 * 1. Legacy single-provider: { type: "oauth", ... } or { type: "api_key", key: "..." }
 * 2. Multi-provider: { anthropic: { type: "oauth", ... }, groq: { type: "api_key", key: "..." } }
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

export type AuthCredential = OAuthCredential | ApiKeyCredential

function isMultiProvider(json: unknown): json is Record<string, unknown> {
	return typeof json === 'object' && json !== null && !('type' in json)
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
			if (cred && typeof cred === 'object' && 'type' in cred) {
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
export async function loadCredential(path: string): Promise<AuthCredential | null> {
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
