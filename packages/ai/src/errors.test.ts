import { describe, expect, test } from 'bun:test'
import {
	classifyError,
	classifyErrorMessage,
	isRetryable,
	isRateLimitError,
	isOverloadedError,
	isTimeoutError,
	isAuthError,
	isBillingError,
	isFormatError,
	isTransientHttpError,
	isContextOverflowError,
	parseRetryAfter,
	getOverflowPatterns
} from './errors'

// ============================================================================
// Individual detectors
// ============================================================================

describe('isRateLimitError', () => {
	test('detects rate limit messages', () => {
		expect(isRateLimitError('rate limit exceeded')).toBe(
			true
		)
		expect(isRateLimitError('Rate_Limit hit')).toBe(true)
		expect(isRateLimitError('too many requests')).toBe(true)
		expect(isRateLimitError('error 429')).toBe(true)
		expect(
			isRateLimitError('exceeded your current quota')
		).toBe(true)
		expect(
			isRateLimitError('resource has been exhausted')
		).toBe(true)
		expect(isRateLimitError('quota exceeded')).toBe(true)
		expect(isRateLimitError('resource_exhausted')).toBe(
			true
		)
		expect(isRateLimitError('usage limit')).toBe(true)
	})

	test('rejects non-rate-limit messages', () => {
		expect(isRateLimitError('authentication failed')).toBe(
			false
		)
		expect(isRateLimitError('internal server error')).toBe(
			false
		)
		expect(isRateLimitError('')).toBe(false)
	})
})

describe('isOverloadedError', () => {
	test('detects overloaded messages', () => {
		expect(isOverloadedError('overloaded_error')).toBe(true)
		expect(isOverloadedError('Server is overloaded')).toBe(
			true
		)
		expect(
			isOverloadedError('"type": "overloaded_error"')
		).toBe(true)
	})

	test('rejects non-overloaded messages', () => {
		expect(isOverloadedError('server error')).toBe(false)
	})
})

describe('isTimeoutError', () => {
	test('detects timeout messages', () => {
		expect(isTimeoutError('request timeout')).toBe(true)
		expect(isTimeoutError('connection timed out')).toBe(
			true
		)
		expect(isTimeoutError('deadline exceeded')).toBe(true)
		expect(
			isTimeoutError('context deadline exceeded')
		).toBe(true)
	})

	test('rejects non-timeout messages', () => {
		expect(isTimeoutError('rate limit exceeded')).toBe(
			false
		)
	})
})

describe('isAuthError', () => {
	test('detects auth messages', () => {
		expect(isAuthError('invalid api key')).toBe(true)
		expect(isAuthError('Invalid_API_Key provided')).toBe(
			true
		)
		expect(isAuthError('incorrect api key')).toBe(true)
		expect(isAuthError('unauthorized')).toBe(true)
		expect(isAuthError('forbidden')).toBe(true)
		expect(isAuthError('access denied')).toBe(true)
		expect(isAuthError('HTTP 401 Unauthorized')).toBe(true)
		expect(isAuthError('error 403')).toBe(true)
		expect(isAuthError('token has expired')).toBe(true)
		expect(isAuthError('no api key found')).toBe(true)
	})

	test('rejects non-auth messages', () => {
		expect(isAuthError('server error')).toBe(false)
	})
})

describe('isBillingError', () => {
	test('detects billing messages', () => {
		expect(isBillingError('payment required')).toBe(true)
		expect(isBillingError('insufficient credits')).toBe(
			true
		)
		expect(isBillingError('HTTP 402')).toBe(true)
		expect(isBillingError('insufficient balance')).toBe(
			true
		)
	})

	test('rejects non-billing messages', () => {
		expect(isBillingError('rate limit')).toBe(false)
	})
})

describe('isFormatError', () => {
	test('detects format messages', () => {
		expect(
			isFormatError('string should match pattern')
		).toBe(true)
		expect(isFormatError('invalid tool_use.id')).toBe(true)
		expect(isFormatError('invalid request format')).toBe(
			true
		)
	})

	test('rejects non-format messages', () => {
		expect(isFormatError('timeout')).toBe(false)
	})
})

describe('isTransientHttpError', () => {
	test('detects transient status codes', () => {
		expect(isTransientHttpError(429)).toBe(true)
		expect(isTransientHttpError(500)).toBe(true)
		expect(isTransientHttpError(502)).toBe(true)
		expect(isTransientHttpError(503)).toBe(true)
		expect(isTransientHttpError(521)).toBe(true)
		expect(isTransientHttpError(522)).toBe(true)
		expect(isTransientHttpError(523)).toBe(true)
		expect(isTransientHttpError(524)).toBe(true)
		expect(isTransientHttpError(529)).toBe(true)
	})

	test('rejects non-transient status codes', () => {
		expect(isTransientHttpError(200)).toBe(false)
		expect(isTransientHttpError(400)).toBe(false)
		expect(isTransientHttpError(401)).toBe(false)
		expect(isTransientHttpError(404)).toBe(false)
	})

	test('extracts status from message strings', () => {
		expect(
			isTransientHttpError('HTTP 502: Bad Gateway')
		).toBe(true)
		expect(
			isTransientHttpError('503 Service Unavailable')
		).toBe(true)
		expect(isTransientHttpError('HTTP 200 OK')).toBe(false)
		expect(isTransientHttpError('HTTP 404 Not Found')).toBe(
			false
		)
	})
})

describe('isContextOverflowError', () => {
	test('detects overflow messages', () => {
		expect(
			isContextOverflowError(
				'prompt is too long: 123456 tokens > 200000 maximum'
			)
		).toBe(true)
		expect(
			isContextOverflowError(
				'maximum context length is 200000 tokens'
			)
		).toBe(true)
		expect(
			isContextOverflowError('context length exceeded')
		).toBe(true)
		expect(
			isContextOverflowError('token limit exceeded')
		).toBe(true)
		expect(
			isContextOverflowError(
				'reduce the length of the messages'
			)
		).toBe(true)
		expect(
			isContextOverflowError('input is too long')
		).toBe(true)
		expect(
			isContextOverflowError('request_too_large')
		).toBe(true)
		expect(
			isContextOverflowError('exceeds model context window')
		).toBe(true)
	})

	test('detects silent overflow via token count', () => {
		expect(
			isContextOverflowError('no error', 250000, 200000)
		).toBe(true)
		expect(
			isContextOverflowError('no error', 100000, 200000)
		).toBe(false)
	})

	test('rejects non-overflow messages', () => {
		expect(isContextOverflowError('rate limit')).toBe(false)
	})
})

describe('getOverflowPatterns', () => {
	test('returns array of patterns', () => {
		const patterns = getOverflowPatterns()
		expect(Array.isArray(patterns)).toBe(true)
		expect(patterns.length).toBeGreaterThan(0)
		expect(patterns[0]).toBeInstanceOf(RegExp)
	})

	test('returns a copy', () => {
		const a = getOverflowPatterns()
		const b = getOverflowPatterns()
		expect(a).not.toBe(b)
	})
})

// ============================================================================
// parseRetryAfter
// ============================================================================

describe('parseRetryAfter', () => {
	test('extracts retryAfter as seconds → ms', () => {
		expect(parseRetryAfter({ retryAfter: 5 })).toBe(5000)
	})

	test('extracts retry_after as seconds → ms', () => {
		expect(parseRetryAfter({ retry_after: 10 })).toBe(10000)
	})

	test('extracts from headers', () => {
		expect(
			parseRetryAfter({ headers: { 'retry-after': '3' } })
		).toBe(3000)
	})

	test('extracts numeric header', () => {
		expect(
			parseRetryAfter({ headers: { 'Retry-After': 7 } })
		).toBe(7000)
	})

	test('returns undefined for no retry info', () => {
		expect(parseRetryAfter({})).toBeUndefined()
		expect(parseRetryAfter(null)).toBeUndefined()
		expect(parseRetryAfter('error')).toBeUndefined()
	})
})

// ============================================================================
// classifyErrorMessage
// ============================================================================

describe('classifyErrorMessage', () => {
	test('classifies transient HTTP errors first', () => {
		expect(
			classifyErrorMessage('HTTP 502: Bad Gateway')
		).toBe('transient')
	})

	test('classifies context overflow', () => {
		expect(classifyErrorMessage('prompt is too long')).toBe(
			'context_overflow'
		)
	})

	test('classifies rate limit', () => {
		expect(
			classifyErrorMessage('rate limit exceeded')
		).toBe('rate_limit')
	})

	test('classifies overloaded', () => {
		expect(classifyErrorMessage('overloaded_error')).toBe(
			'overloaded'
		)
	})

	test('classifies format errors', () => {
		expect(
			classifyErrorMessage('string should match pattern')
		).toBe('format')
	})

	test('classifies billing errors', () => {
		expect(
			classifyErrorMessage('insufficient credits')
		).toBe('billing')
	})

	test('classifies timeout', () => {
		expect(classifyErrorMessage('request timed out')).toBe(
			'timeout'
		)
	})

	test('classifies auth errors', () => {
		expect(classifyErrorMessage('invalid api key')).toBe(
			'auth'
		)
	})

	test('returns null for unknown errors', () => {
		expect(
			classifyErrorMessage('something weird happened')
		).toBeNull()
	})

	test('returns null for empty string', () => {
		expect(classifyErrorMessage('')).toBeNull()
	})
})

// ============================================================================
// classifyError (structured errors)
// ============================================================================

describe('classifyError', () => {
	test('classifies plain string', () => {
		const result = classifyError('rate limit exceeded')
		expect(result.errorClass).toBe('rate_limit')
		expect(result.retryable).toBe(true)
		expect(result.requiresRecovery).toBe(false)
	})

	test('classifies Error objects', () => {
		const result = classifyError(
			new Error('connection timed out')
		)
		expect(result.errorClass).toBe('timeout')
		expect(result.retryable).toBe(true)
		expect(result.message).toBe('connection timed out')
	})

	test('classifies structured SDK errors with status code', () => {
		const sdkError = Object.assign(
			new Error('Too many requests'),
			{
				status: 429
			}
		)
		const result = classifyError(sdkError)
		expect(result.errorClass).toBe('rate_limit')
		expect(result.statusCode).toBe(429)
		expect(result.retryable).toBe(true)
	})

	test('classifies SDK errors with error.type', () => {
		const sdkError = Object.assign(
			new Error('Your credit balance is too low'),
			{
				status: 400,
				error: { type: 'insufficient_quota' }
			}
		)
		const result = classifyError(sdkError)
		// The error type is prepended to message for classification
		expect(result.message).toContain('insufficient_quota')
	})

	test('classifies 401 as auth via status code', () => {
		const sdkError = Object.assign(
			new Error('Unauthorized'),
			{
				status: 401
			}
		)
		const result = classifyError(sdkError)
		expect(result.errorClass).toBe('auth')
		expect(result.retryable).toBe(false)
	})

	test('classifies 402 as billing via status code', () => {
		const sdkError = Object.assign(
			new Error('Payment Required'),
			{
				status: 402
			}
		)
		const result = classifyError(sdkError)
		expect(result.errorClass).toBe('billing')
		expect(result.retryable).toBe(false)
	})

	test('classifies transient 502 via status code', () => {
		const sdkError = Object.assign(
			new Error('Bad Gateway'),
			{
				status: 502
			}
		)
		const result = classifyError(sdkError)
		expect(result.errorClass).toBe('transient')
		expect(result.retryable).toBe(true)
	})

	test('extracts retryAfterMs from SDK error', () => {
		const sdkError = Object.assign(
			new Error('Rate limited'),
			{
				status: 429,
				headers: { 'retry-after': '5' }
			}
		)
		const result = classifyError(sdkError)
		expect(result.retryAfterMs).toBe(5000)
	})

	test('context_overflow has requiresRecovery=true', () => {
		const result = classifyError(
			'prompt is too long: 250000 tokens'
		)
		expect(result.errorClass).toBe('context_overflow')
		expect(result.retryable).toBe(true)
		expect(result.requiresRecovery).toBe(true)
	})

	test('non-retryable errors have retryable=false', () => {
		expect(classifyError('invalid api key').retryable).toBe(
			false
		)
		expect(
			classifyError('insufficient credits').retryable
		).toBe(false)
		expect(
			classifyError('string should match pattern').retryable
		).toBe(false)
	})

	test('unknown errors have retryable=false', () => {
		const result = classifyError(
			'something completely unknown'
		)
		expect(result.errorClass).toBeNull()
		expect(result.retryable).toBe(false)
		expect(result.requiresRecovery).toBe(false)
	})

	test('handles null/undefined gracefully', () => {
		const result = classifyError(null)
		expect(result.errorClass).toBeNull()
		expect(result.message).toBe('null')
	})
})

// ============================================================================
// isRetryable
// ============================================================================

describe('isRetryable', () => {
	test('returns true for retryable classified errors', () => {
		expect(isRetryable(classifyError('rate limit'))).toBe(
			true
		)
		expect(isRetryable(classifyError('overloaded'))).toBe(
			true
		)
		expect(isRetryable(classifyError('timed out'))).toBe(
			true
		)
		expect(
			isRetryable(classifyError('HTTP 502: error'))
		).toBe(true)
		expect(
			isRetryable(classifyError('prompt is too long'))
		).toBe(true)
	})

	test('returns false for non-retryable classified errors', () => {
		expect(
			isRetryable(classifyError('invalid api key'))
		).toBe(false)
		expect(
			isRetryable(classifyError('insufficient credits'))
		).toBe(false)
		expect(
			isRetryable(
				classifyError('string should match pattern')
			)
		).toBe(false)
		expect(
			isRetryable(classifyError('unknown error xyz'))
		).toBe(false)
	})
})
