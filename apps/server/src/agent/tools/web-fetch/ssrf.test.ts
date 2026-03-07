import { describe, expect, test } from 'bun:test'
import {
	isPrivateIpAddress,
	isBlockedHostname,
	validateHostname,
	SsrFBlockedError,
	normalizeHostname,
	type LookupFn
} from './ssrf'

// ── normalizeHostname ───────────────────────────────────────────────

describe('normalizeHostname', () => {
	test('lowercases and trims', () => {
		expect(normalizeHostname('  Example.COM  ')).toBe(
			'example.com'
		)
	})
	test('strips trailing dot', () => {
		expect(normalizeHostname('example.com.')).toBe(
			'example.com'
		)
	})
	test('unwraps IPv6 brackets', () => {
		expect(normalizeHostname('[::1]')).toBe('::1')
	})
})

// ── isBlockedHostname ───────────────────────────────────────────────

describe('isBlockedHostname', () => {
	test('blocks localhost', () => {
		expect(isBlockedHostname('localhost')).toBe(true)
	})
	test('blocks LOCALHOST (case insensitive)', () => {
		expect(isBlockedHostname('LOCALHOST')).toBe(true)
	})
	test('blocks metadata.google.internal', () => {
		expect(
			isBlockedHostname('metadata.google.internal')
		).toBe(true)
	})
	test('blocks .localhost suffix', () => {
		expect(isBlockedHostname('foo.localhost')).toBe(true)
	})
	test('blocks .local suffix', () => {
		expect(isBlockedHostname('printer.local')).toBe(true)
	})
	test('blocks .internal suffix', () => {
		expect(isBlockedHostname('service.internal')).toBe(true)
	})
	test('allows example.com', () => {
		expect(isBlockedHostname('example.com')).toBe(false)
	})
	test('allows google.com', () => {
		expect(isBlockedHostname('google.com')).toBe(false)
	})
})

// ── isPrivateIpAddress ──────────────────────────────────────────────

describe('isPrivateIpAddress', () => {
	// IPv4 private ranges
	test.each([
		['127.0.0.1', true],
		['127.255.255.255', true],
		['10.0.0.1', true],
		['10.255.255.255', true],
		['192.168.1.1', true],
		['192.168.0.0', true],
		['172.16.0.1', true],
		['172.31.255.255', true],
		['169.254.169.254', true],
		['169.254.0.1', true],
		['100.64.0.1', true],
		['100.127.255.255', true],
		['0.0.0.0', true]
	])(
		'IPv4 %s → private=%s',
		(ip: string, expected: boolean) => {
			expect(isPrivateIpAddress(ip)).toBe(expected)
		}
	)

	// IPv4 public
	test.each([
		['8.8.8.8', false],
		['1.1.1.1', false],
		['93.184.216.34', false],
		['172.32.0.1', false],
		['100.128.0.1', false]
	])(
		'IPv4 %s → private=%s',
		(ip: string, expected: boolean) => {
			expect(isPrivateIpAddress(ip)).toBe(expected)
		}
	)

	// IPv6
	test('::1 is private (loopback)', () => {
		expect(isPrivateIpAddress('::1')).toBe(true)
	})
	test(':: is private (unspecified)', () => {
		expect(isPrivateIpAddress('::')).toBe(true)
	})
	test('fe80::1 is private (link-local)', () => {
		expect(isPrivateIpAddress('fe80::1')).toBe(true)
	})
	test('fc00::1 is private (unique-local)', () => {
		expect(isPrivateIpAddress('fc00::1')).toBe(true)
	})
	test('fd00::1 is private (unique-local)', () => {
		expect(isPrivateIpAddress('fd00::1')).toBe(true)
	})
	test('fec0::1 is private (site-local)', () => {
		expect(isPrivateIpAddress('fec0::1')).toBe(true)
	})

	// IPv6-embedded IPv4
	test('::ffff:127.0.0.1 is private (IPv4-mapped)', () => {
		expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(
			true
		)
	})
	test('::ffff:10.0.0.1 is private (IPv4-mapped)', () => {
		expect(isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true)
	})
	test('::ffff:8.8.8.8 is public (IPv4-mapped)', () => {
		expect(isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false)
	})

	// Bracketed IPv6
	test('[::1] is private', () => {
		expect(isPrivateIpAddress('[::1]')).toBe(true)
	})

	// Public IPv6
	test('2607:f8b0:4004:800::200e is public', () => {
		expect(
			isPrivateIpAddress('2607:f8b0:4004:800::200e')
		).toBe(false)
	})

	// Malformed → fail closed
	test('malformed IPv6 returns true (fail closed)', () => {
		expect(isPrivateIpAddress(':::invalid')).toBe(true)
	})
})

// ── validateHostname ────────────────────────────────────────────────

describe('validateHostname', () => {
	const mockLookup = (async (
		hostname: string,
		options: { all?: boolean } | number | undefined
	) => {
		const map: Record<string, string> = {
			'example.com': '93.184.216.34',
			'evil.com': '127.0.0.1',
			'sneaky.com': '169.254.169.254',
			localhost: '127.0.0.1'
		}
		const ip = map[hostname as string]
		if (!ip) throw new Error(`ENOTFOUND: ${hostname}`)
		const family = ip.includes(':') ? 6 : 4
		if (
			options &&
			typeof options === 'object' &&
			'all' in options &&
			options.all
		) {
			return [{ address: ip, family }]
		}
		return { address: ip, family }
	}) as unknown as LookupFn

	test('allows public hostname and returns resolved IPs', async () => {
		const ips = await validateHostname('example.com', {
			lookupFn: mockLookup
		})
		expect(ips).toEqual(['93.184.216.34'])
	})

	test('blocks localhost', async () => {
		await expect(
			validateHostname('localhost', {
				lookupFn: mockLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks hostname resolving to 127.0.0.1', async () => {
		await expect(
			validateHostname('evil.com', {
				lookupFn: mockLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks hostname resolving to 169.254.169.254', async () => {
		await expect(
			validateHostname('sneaky.com', {
				lookupFn: mockLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks .internal suffix', async () => {
		await expect(
			validateHostname('metadata.google.internal', {
				lookupFn: mockLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks IP address directly', async () => {
		await expect(
			validateHostname('127.0.0.1', {
				lookupFn: mockLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('allows private network with policy', async () => {
		const ips = await validateHostname('evil.com', {
			lookupFn: mockLookup,
			policy: { allowPrivateNetwork: true }
		})
		expect(ips).toEqual(['127.0.0.1'])
	})

	test('allows explicitly allowed hostname', async () => {
		const ips = await validateHostname('localhost', {
			lookupFn: mockLookup,
			policy: { allowedHostnames: ['localhost'] }
		})
		expect(ips).toEqual(['127.0.0.1'])
	})

	test('blocks hostname not in allowlist', async () => {
		await expect(
			validateHostname('example.com', {
				lookupFn: mockLookup,
				policy: {
					hostnameAllowlist: ['other-site.com']
				}
			})
		).rejects.toThrow(SsrFBlockedError)
	})
})
