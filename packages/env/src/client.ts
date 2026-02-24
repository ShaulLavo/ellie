// ============================================================================
// Client environment
// ============================================================================
//
// The studio frontend is served from the same origin as the API server,
// so `window.location.origin` is the correct base URL. No build-time env
// inlining is needed.
//
// If cross-origin deployment is needed in the future, inject config via
// a <script> tag or a /config endpoint rather than process.env.
// ============================================================================

export interface ClientEnv {
	/** API base URL — always the current origin (same-origin setup). */
	readonly API_BASE_URL: string
}

export const env: ClientEnv = {
	API_BASE_URL: window.location.origin
}
