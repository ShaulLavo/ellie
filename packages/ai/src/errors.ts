/**
 * Error classification for LLM API errors.
 *
 * Single source of truth for error semantics across all providers.
 * Classifies error strings and structured SDK errors into actionable categories.
 *
 * Ported from openclaw's error classification patterns
 * (src/agents/pi-embedded-helpers/errors.ts) with additions for
 * structured Anthropic SDK errors.
 */

// ============================================================================
// Types
// ============================================================================

export type ErrorClass =
	| 'rate_limit'
	| 'overloaded'
	| 'timeout'
	| 'context_overflow'
	| 'auth'
	| 'billing'
	| 'transient'
	| 'format'
	| null

export interface ClassifiedError {
	errorClass: ErrorClass
	/** Whether this error can be retried */
	retryable: boolean
	/** Whether recovery action (e.g. context trim) is needed before retry */
	requiresRecovery: boolean
	message: string
	statusCode?: number
	retryAfterMs?: number
}

// ============================================================================
// Error patterns (ported from openclaw ERROR_PATTERNS)
// ============================================================================

type ErrorPattern = RegExp | string

const ERROR_PATTERNS = {
	rateLimit: [
		/rate[_ ]limit|too many requests|429/i,
		'exceeded your current quota',
		'resource has been exhausted',
		'quota exceeded',
		'resource_exhausted',
		'usage limit'
	] as readonly ErrorPattern[],

	overloaded: [
		/overloaded_error|"type"\s*:\s*"overloaded_error"/i,
		'overloaded'
	] as readonly ErrorPattern[],

	timeout: [
		'timeout',
		'timed out',
		'deadline exceeded',
		'context deadline exceeded',
		/without sending (?:any )?chunks?/i,
		/\bstop reason:\s*abort\b/i
	] as readonly ErrorPattern[],

	billing: [
		/["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b/i,
		'payment required',
		'insufficient credits',
		'credit balance',
		'insufficient balance'
	] as readonly ErrorPattern[],

	auth: [
		/invalid[_ ]?api[_ ]?key/i,
		'incorrect api key',
		'invalid token',
		'authentication',
		're-authenticate',
		'oauth token refresh failed',
		'unauthorized',
		'forbidden',
		'access denied',
		'expired',
		'token has expired',
		/\b401\b/,
		/\b403\b/,
		'no credentials found',
		'no api key found'
	] as readonly ErrorPattern[],

	format: [
		'string should match pattern',
		'tool_use.id',
		'tool_use_id',
		'invalid request format'
	] as readonly ErrorPattern[]
} as const

// ============================================================================
// Context overflow patterns (subsumes overflow.ts)
// ============================================================================

const OVERFLOW_PATTERNS: RegExp[] = [
	/request_too_large/i,
	/request exceeds the maximum size/i,
	/context length exceeded/i,
	/maximum context length/i,
	/prompt is too long/i,
	/exceeds model context window/i,
	/exceeds the context window/i,
	/token limit exceeded/i,
	/reduce the length of the messages/i,
	/input is too long/i,
	/request size exceeds/i
]

// ============================================================================
// Transient HTTP codes (from openclaw)
// ============================================================================

const TRANSIENT_HTTP_ERROR_CODES = new Set([
	429, 500, 502, 503, 521, 522, 523, 524, 529
])

const HTTP_STATUS_PREFIX_RE =
	/^(?:http\s*)?(\d{3})\s*[:\s]/i

// ============================================================================
// Pattern matching
// ============================================================================

function matchesErrorPatterns(
	raw: string,
	patterns: readonly ErrorPattern[]
): boolean {
	if (!raw) return false
	const lower = raw.toLowerCase()
	return patterns.some(pattern =>
		pattern instanceof RegExp
			? pattern.test(lower)
			: lower.includes(pattern)
	)
}

// ============================================================================
// Individual detectors
// ============================================================================

export function isRateLimitError(msg: string): boolean {
	return matchesErrorPatterns(msg, ERROR_PATTERNS.rateLimit)
}

export function isOverloadedError(msg: string): boolean {
	return matchesErrorPatterns(
		msg,
		ERROR_PATTERNS.overloaded
	)
}

export function isTimeoutError(msg: string): boolean {
	return matchesErrorPatterns(msg, ERROR_PATTERNS.timeout)
}

export function isAuthError(msg: string): boolean {
	return matchesErrorPatterns(msg, ERROR_PATTERNS.auth)
}

export function isBillingError(msg: string): boolean {
	return matchesErrorPatterns(msg, ERROR_PATTERNS.billing)
}

export function isFormatError(msg: string): boolean {
	return matchesErrorPatterns(msg, ERROR_PATTERNS.format)
}

/**
 * Check if an HTTP status code represents a transient error.
 * Can also extract status from error message strings like "HTTP 502: Bad Gateway".
 */
export function isTransientHttpError(
	statusOrMessage: number | string
): boolean {
	if (typeof statusOrMessage === 'number') {
		return TRANSIENT_HTTP_ERROR_CODES.has(statusOrMessage)
	}
	const match = HTTP_STATUS_PREFIX_RE.exec(statusOrMessage)
	if (match) {
		const code = parseInt(match[1], 10)
		return TRANSIENT_HTTP_ERROR_CODES.has(code)
	}
	return false
}

/**
 * Detect whether an error indicates a context overflow.
 *
 * Two mechanisms:
 * 1. Pattern matching against known provider error messages
 * 2. Silent overflow detection by comparing input tokens to contextWindow
 */
export function isContextOverflowError(
	message: string,
	inputTokens?: number,
	contextWindow?: number
): boolean {
	for (const pattern of OVERFLOW_PATTERNS) {
		if (pattern.test(message)) {
			return true
		}
	}

	if (
		inputTokens !== undefined &&
		contextWindow !== undefined &&
		inputTokens > contextWindow
	) {
		return true
	}

	return false
}

/** Returns the overflow detection patterns (for testing/extension). */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS]
}

// ============================================================================
// Retry-After extraction
// ============================================================================

/**
 * Extract a Retry-After delay (in ms) from an error object.
 * Handles:
 * - error.headers['retry-after'] (seconds or HTTP-date)
 * - error.retryAfter (number, seconds)
 * - error.retry_after (number, seconds)
 */
export function parseRetryAfter(
	error: unknown
): number | undefined {
	if (!error || typeof error !== 'object') return undefined

	const err = error as Record<string, unknown>

	// Check for retryAfter as a direct number (seconds)
	if (
		typeof err.retryAfter === 'number' &&
		err.retryAfter > 0
	) {
		return err.retryAfter * 1000
	}
	if (
		typeof err.retry_after === 'number' &&
		err.retry_after > 0
	) {
		return err.retry_after * 1000
	}

	// Check headers
	const headers = err.headers as
		| Record<string, unknown>
		| undefined
	if (headers) {
		const retryHeader =
			headers['retry-after'] ?? headers['Retry-After']
		if (typeof retryHeader === 'string') {
			const seconds = parseFloat(retryHeader)
			if (!isNaN(seconds) && seconds > 0) {
				return seconds * 1000
			}
		}
		if (
			typeof retryHeader === 'number' &&
			retryHeader > 0
		) {
			return retryHeader * 1000
		}
	}

	return undefined
}

// ============================================================================
// Master classifier
// ============================================================================

/**
 * Classify an error message string into an ErrorClass.
 * Follows openclaw's classifyFailoverReason() priority order.
 */
export function classifyErrorMessage(
	message: string
): ErrorClass {
	if (!message) return null

	// Check transient HTTP first (e.g. "HTTP 502: Bad Gateway")
	if (isTransientHttpError(message)) return 'transient'

	// Context overflow
	if (isContextOverflowError(message))
		return 'context_overflow'

	// Rate limit (includes 429)
	if (isRateLimitError(message)) return 'rate_limit'

	// Overloaded
	if (isOverloadedError(message)) return 'overloaded'

	// Format errors (not retryable)
	if (isFormatError(message)) return 'format'

	// Billing errors (not retryable)
	if (isBillingError(message)) return 'billing'

	// Timeout
	if (isTimeoutError(message)) return 'timeout'

	// Auth errors (not retryable)
	if (isAuthError(message)) return 'auth'

	return null
}

/**
 * Classify an error from any source (structured SDK error or string).
 *
 * Handles:
 * - Anthropic SDK errors with .status and .error?.type
 * - Generic Error objects with .message
 * - Plain strings
 * - Unknown error shapes
 */
export function classifyError(
	error: unknown
): ClassifiedError {
	let message: string
	let statusCode: number | undefined
	let retryAfterMs: number | undefined

	if (typeof error === 'string') {
		message = error
	} else if (error instanceof Error) {
		message = error.message

		// Handle structured SDK errors (Anthropic, OpenAI)
		const errObj = error as unknown as Record<
			string,
			unknown
		>

		// Extract status code
		if (typeof errObj.status === 'number') {
			statusCode = errObj.status
		} else if (typeof errObj.statusCode === 'number') {
			statusCode = errObj.statusCode
		}

		// Extract error type from SDK (e.g. error.error.type = "rate_limit_error")
		const innerError = errObj.error as
			| Record<string, unknown>
			| undefined
		if (innerError && typeof innerError.type === 'string') {
			// Prepend the SDK error type for better classification
			message = `${innerError.type}: ${message}`
		}

		// Extract retry-after
		retryAfterMs = parseRetryAfter(error)
	} else if (error !== null && typeof error === 'object') {
		const errObj = error as Record<string, unknown>
		message =
			typeof errObj.message === 'string'
				? errObj.message
				: String(error)

		if (typeof errObj.status === 'number') {
			statusCode = errObj.status
		}

		retryAfterMs = parseRetryAfter(error)
	} else {
		message = String(error)
	}

	// First try: classify by HTTP status code directly
	let errorClass: ErrorClass = null
	if (statusCode !== undefined) {
		if (statusCode === 429) {
			errorClass = 'rate_limit'
		} else if (statusCode === 401 || statusCode === 403) {
			errorClass = 'auth'
		} else if (statusCode === 402) {
			errorClass = 'billing'
		} else if (TRANSIENT_HTTP_ERROR_CODES.has(statusCode)) {
			errorClass = 'transient'
		}
	}

	// Second try: classify by message content
	if (errorClass === null) {
		errorClass = classifyErrorMessage(message)
	}

	const retryable =
		errorClass === 'rate_limit' ||
		errorClass === 'overloaded' ||
		errorClass === 'timeout' ||
		errorClass === 'transient' ||
		errorClass === 'context_overflow'

	const requiresRecovery = errorClass === 'context_overflow'

	return {
		errorClass,
		retryable,
		requiresRecovery,
		message,
		statusCode,
		retryAfterMs
	}
}

/**
 * Check if a classified error is retryable.
 */
export function isRetryable(
	classified: ClassifiedError
): boolean {
	return classified.retryable
}
