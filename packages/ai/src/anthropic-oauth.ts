/**
 * Anthropic adapter factory with OAuth token support.
 *
 * Creates an Anthropic text adapter using an OAuth access token
 * instead of an API key. Requires the `anthropic-beta` header
 * for OAuth token authentication.
 */

import { createAnthropicChat, type AnthropicChatModel } from "@tanstack/ai-anthropic"
import type { AnyTextAdapter } from "@tanstack/ai"
import { loadProviderCredential, type OAuthCredential } from "./credentials"

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

// Required beta header for OAuth token authentication
const OAUTH_BETA_HEADER = "claude-code-20250219,oauth-2025-04-20"

/**
 * Create an Anthropic adapter using an OAuth access token.
 *
 * Uses `authToken` (Bearer token) instead of `apiKey` (X-Api-Key header).
 * Requires the OAuth beta header.
 *
 * @example
 * ```ts
 * import { anthropicOAuth } from "@ellie/ai/anthropic-oauth"
 *
 * const adapter = anthropicOAuth("claude-haiku-4-5", accessToken)
 * ```
 */
export function anthropicOAuth(model: string, accessToken: string): AnyTextAdapter {
  return createAnthropicChat(model as AnthropicChatModel, "", {
    authToken: accessToken,
    defaultHeaders: {
      "anthropic-beta": OAUTH_BETA_HEADER,
    },
  } as Record<string, unknown>)
}

/**
 * Create an Anthropic adapter from a credentials file.
 *
 * Loads the credential by name and creates an adapter with the token.
 * Returns null if credentials are missing or invalid.
 *
 * @param model - The Anthropic model ID
 * @param credentialsPath - Path to the .credentials.json file
 * @param name - Credential name in the store (default: "anthropic")
 *
 * @example
 * ```ts
 * import { anthropicFromCredentials } from "@ellie/ai/anthropic-oauth"
 *
 * const adapter = await anthropicFromCredentials(
 *   "claude-haiku-4-5",
 *   ".credentials.json",
 * )
 * ```
 */
export async function anthropicFromCredentials(
  model: string,
  credentialsPath: string,
  name = "anthropic",
): Promise<AnyTextAdapter | null> {
  const cred = await loadProviderCredential(credentialsPath, name)
  if (!cred) return null

  if (cred.type === "oauth") {
    return anthropicOAuth(model, cred.access_token)
  }

  if (cred.type === "api_key") {
    return createAnthropicChat(model as AnthropicChatModel, cred.key)
  }

  return null
}

// ── Token refresh ────────────────────────────────────────────────────────────

/**
 * Refresh an Anthropic OAuth token using the refresh_token grant.
 * Returns the updated credential, or null if refresh fails.
 *
 * Does NOT save to disk — caller is responsible for persisting.
 */
export async function refreshOAuthToken(
  cred: OAuthCredential,
): Promise<OAuthCredential | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: cred.client_id,
        refresh_token: cred.refresh_token,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(
        `[anthropic-oauth] refresh failed (${res.status}): ${body.slice(0, 200)}`,
      )
      return null
    }

    const json = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    return {
      type: "oauth",
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
      client_id: cred.client_id,
      client_secret: cred.client_secret,
    }
  } catch (err) {
    console.error(
      `[anthropic-oauth] refresh error: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}
