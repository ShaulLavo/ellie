import { describe, expect, test } from 'bun:test'
import {
	isRetryableDownloadError,
	summarizeDownloadError
} from './auto-setup'

describe('auto-setup download errors', () => {
	test('classifies read timeouts as retryable', () => {
		expect(
			isRetryableDownloadError(
				'ReadTimeout: The read operation timed out'
			)
		).toBe(true)
	})

	test('classifies connection resets as retryable', () => {
		expect(
			isRetryableDownloadError(
				'Connection reset by peer during download'
			)
		).toBe(true)
	})

	test('does not classify auth errors as retryable', () => {
		expect(
			isRetryableDownloadError(
				'401 Unauthorized from civitai'
			)
		).toBe(false)
	})

	test('prefers stderr when summarizing command failure', () => {
		expect(
			summarizeDownloadError(
				'ignored stdout',
				'actual stderr detail'
			)
		).toBe('actual stderr detail')
	})
})
