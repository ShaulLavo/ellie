/**
 * SSRF protection — hostname and IP validation.
 *
 * Adapted from OpenClaw's ssrf.ts. Covers:
 *   - Blocked hostnames (localhost, .local, .internal, metadata endpoints)
 *   - Private/internal IPv4 ranges (10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x, 100.64-127.x)
 *   - IPv6 loopback, link-local, unique-local, site-local
 *   - IPv6-embedded IPv4 (mapped, compatible, NAT64, 6to4, Teredo)
 *   - Hostname allowlist for opt-in exceptions
 *   - DNS resolution check (all resolved IPs must be public)
 *
 * Skipped from OpenClaw: undici DNS pinning (Bun's fetch doesn't support undici dispatchers).
 * Pre-flight DNS validation still catches the vast majority of SSRF.
 */

import { lookup as dnsLookup } from 'node:dns/promises'

// ── Error ───────────────────────────────────────────────────────────

export class SsrFBlockedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SsrFBlockedError'
	}
}

// ── Policy ──────────────────────────────────────────────────────────

export type SsrFPolicy = {
	allowPrivateNetwork?: boolean
	allowedHostnames?: string[]
	hostnameAllowlist?: string[]
}

// ── Hostname normalization (inlined from hostname.ts) ───────────────

export function normalizeHostname(
	hostname: string
): string {
	const normalized = hostname
		.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	if (
		normalized.startsWith('[') &&
		normalized.endsWith(']')
	) {
		return normalized.slice(1, -1)
	}
	return normalized
}

// ── Blocked hostnames ───────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'metadata.google.internal'
])

export function isBlockedHostname(
	hostname: string
): boolean {
	const normalized = normalizeHostname(hostname)
	if (!normalized) return false
	if (BLOCKED_HOSTNAMES.has(normalized)) return true
	return (
		normalized.endsWith('.localhost') ||
		normalized.endsWith('.local') ||
		normalized.endsWith('.internal')
	)
}

// ── Hostname allowlist ──────────────────────────────────────────────

function normalizeHostnameAllowlist(
	values?: string[]
): string[] {
	if (!values || values.length === 0) return []
	return Array.from(
		new Set(
			values
				.map(v => normalizeHostname(v))
				.filter(
					v => v !== '*' && v !== '*.' && v.length > 0
				)
		)
	)
}

function isHostnameAllowedByPattern(
	hostname: string,
	pattern: string
): boolean {
	if (pattern.startsWith('*.')) {
		const suffix = pattern.slice(2)
		if (!suffix || hostname === suffix) return false
		return hostname.endsWith(`.${suffix}`)
	}
	return hostname === pattern
}

function matchesHostnameAllowlist(
	hostname: string,
	allowlist: string[]
): boolean {
	if (allowlist.length === 0) return true
	return allowlist.some(pattern =>
		isHostnameAllowedByPattern(hostname, pattern)
	)
}

// ── IPv4 parsing & private range check ──────────────────────────────

function parseIpv4(address: string): number[] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const numbers = parts.map(p => Number.parseInt(p, 10))
	if (
		numbers.some(v => Number.isNaN(v) || v < 0 || v > 255)
	)
		return null
	return numbers
}

function isPrivateIpv4(parts: number[]): boolean {
	const [octet1, octet2] = parts
	if (octet1 === 0) return true // 0.0.0.0/8
	if (octet1 === 10) return true // 10.0.0.0/8
	if (octet1 === 127) return true // 127.0.0.0/8
	if (octet1 === 169 && octet2 === 254) return true // link-local
	if (octet1 === 172 && octet2 >= 16 && octet2 <= 31)
		return true // 172.16-31.x
	if (octet1 === 192 && octet2 === 168) return true // 192.168.x
	if (octet1 === 100 && octet2 >= 64 && octet2 <= 127)
		return true // CGN
	return false
}

// ── IPv6 parsing ────────────────────────────────────────────────────

function stripIpv6ZoneId(address: string): string {
	const index = address.indexOf('%')
	return index >= 0 ? address.slice(0, index) : address
}

function parseIpv6Hextets(
	address: string
): number[] | null {
	let input = stripIpv6ZoneId(address.trim().toLowerCase())
	if (!input) return null

	// Handle IPv4-embedded IPv6 like ::ffff:127.0.0.1
	if (input.includes('.')) {
		const lastColon = input.lastIndexOf(':')
		if (lastColon < 0) return null
		const ipv4 = parseIpv4(input.slice(lastColon + 1))
		if (!ipv4) return null
		const high = (ipv4[0] << 8) + ipv4[1]
		const low = (ipv4[2] << 8) + ipv4[3]
		input = `${input.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`
	}

	const doubleColonParts = input.split('::')
	if (doubleColonParts.length > 2) return null

	const headParts =
		doubleColonParts[0]?.length > 0
			? doubleColonParts[0].split(':').filter(Boolean)
			: []
	const tailParts =
		doubleColonParts.length === 2 &&
		doubleColonParts[1]?.length > 0
			? doubleColonParts[1].split(':').filter(Boolean)
			: []

	const missingParts =
		8 - headParts.length - tailParts.length
	if (missingParts < 0) return null

	const fullParts =
		doubleColonParts.length === 1
			? input.split(':')
			: [
					...headParts,
					...Array.from(
						{ length: missingParts },
						() => '0'
					),
					...tailParts
				]

	if (fullParts.length !== 8) return null

	const hextets: number[] = []
	for (const part of fullParts) {
		if (!part) return null
		const value = Number.parseInt(part, 16)
		if (Number.isNaN(value) || value < 0 || value > 0xffff)
			return null
		hextets.push(value)
	}
	return hextets
}

// ── IPv6-embedded IPv4 extraction ───────────────────────────────────

function decodeIpv4FromHextets(
	high: number,
	low: number
): number[] {
	return [
		(high >>> 8) & 0xff,
		high & 0xff,
		(low >>> 8) & 0xff,
		low & 0xff
	]
}

type EmbeddedIpv4Rule = {
	matches: (hextets: number[]) => boolean
	extract: (
		hextets: number[]
	) => [high: number, low: number]
}

const EMBEDDED_IPV4_RULES: EmbeddedIpv4Rule[] = [
	{
		// IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
		matches: h =>
			h[0] === 0 &&
			h[1] === 0 &&
			h[2] === 0 &&
			h[3] === 0 &&
			h[4] === 0 &&
			(h[5] === 0xffff || h[5] === 0),
		extract: h => [h[6], h[7]]
	},
	{
		// NAT64 well-known prefix 64:ff9b::/96
		matches: h =>
			h[0] === 0x0064 &&
			h[1] === 0xff9b &&
			h[2] === 0 &&
			h[3] === 0 &&
			h[4] === 0 &&
			h[5] === 0,
		extract: h => [h[6], h[7]]
	},
	{
		// NAT64 local-use prefix 64:ff9b:1::/48
		matches: h =>
			h[0] === 0x0064 &&
			h[1] === 0xff9b &&
			h[2] === 0x0001 &&
			h[3] === 0 &&
			h[4] === 0 &&
			h[5] === 0,
		extract: h => [h[6], h[7]]
	},
	{
		// 6to4 prefix 2002::/16
		matches: h => h[0] === 0x2002,
		extract: h => [h[1], h[2]]
	},
	{
		// Teredo prefix 2001:0000::/32, client IPv4 XOR 0xffff
		matches: h => h[0] === 0x2001 && h[1] === 0x0000,
		extract: h => [h[6] ^ 0xffff, h[7] ^ 0xffff]
	}
]

function extractIpv4FromEmbeddedIpv6(
	hextets: number[]
): number[] | null {
	for (const rule of EMBEDDED_IPV4_RULES) {
		if (!rule.matches(hextets)) continue
		const [high, low] = rule.extract(hextets)
		return decodeIpv4FromHextets(high, low)
	}
	return null
}

// ── Public IP check ─────────────────────────────────────────────────

export function isPrivateIpAddress(
	address: string
): boolean {
	let normalized = address.trim().toLowerCase()
	if (
		normalized.startsWith('[') &&
		normalized.endsWith(']')
	) {
		normalized = normalized.slice(1, -1)
	}
	if (!normalized) return false

	if (normalized.includes(':')) {
		const hextets = parseIpv6Hextets(normalized)
		if (!hextets) return true // fail closed

		const isUnspecified = hextets.every(h => h === 0)
		const isLoopback =
			hextets[0] === 0 &&
			hextets[1] === 0 &&
			hextets[2] === 0 &&
			hextets[3] === 0 &&
			hextets[4] === 0 &&
			hextets[5] === 0 &&
			hextets[6] === 0 &&
			hextets[7] === 1
		if (isUnspecified || isLoopback) return true

		const embeddedIpv4 =
			extractIpv4FromEmbeddedIpv6(hextets)
		if (embeddedIpv4) return isPrivateIpv4(embeddedIpv4)

		// IPv6 private/internal ranges
		const first = hextets[0]
		if ((first & 0xffc0) === 0xfe80) return true // link-local fe80::/10
		if ((first & 0xffc0) === 0xfec0) return true // site-local fec0::/10
		if ((first & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
		return false
	}

	const ipv4 = parseIpv4(normalized)
	if (!ipv4) return false
	return isPrivateIpv4(ipv4)
}

// ── Hostname validation with DNS resolution ─────────────────────────

export type LookupFn = typeof dnsLookup

/**
 * Validate a hostname against SSRF rules and return resolved IP addresses.
 *
 * Returns the validated IP addresses so callers can pin the connection to
 * the resolved IPs, preventing DNS rebinding (TOCTOU) attacks.
 */
export async function validateHostname(
	hostname: string,
	params: {
		lookupFn?: LookupFn
		policy?: SsrFPolicy
	} = {}
): Promise<string[]> {
	const normalized = normalizeHostname(hostname)
	if (!normalized) {
		throw new Error('Invalid hostname')
	}

	const allowPrivateNetwork = Boolean(
		params.policy?.allowPrivateNetwork
	)
	const allowedHostnames = new Set(
		(params.policy?.allowedHostnames ?? []).map(h =>
			normalizeHostname(h)
		)
	)
	const hostnameAllowlist = normalizeHostnameAllowlist(
		params.policy?.hostnameAllowlist
	)
	const isExplicitAllowed = allowedHostnames.has(normalized)

	if (
		!matchesHostnameAllowlist(normalized, hostnameAllowlist)
	) {
		throw new SsrFBlockedError(
			`Blocked hostname (not in allowlist): ${hostname}`
		)
	}

	if (!allowPrivateNetwork && !isExplicitAllowed) {
		if (isBlockedHostname(normalized)) {
			throw new SsrFBlockedError(
				`Blocked hostname: ${hostname}`
			)
		}
		if (isPrivateIpAddress(normalized)) {
			throw new SsrFBlockedError(
				'Blocked: private/internal IP address'
			)
		}
	}

	const lookupFn = params.lookupFn ?? dnsLookup
	const results = await lookupFn(normalized, { all: true })
	if (results.length === 0) {
		throw new Error(
			`Unable to resolve hostname: ${hostname}`
		)
	}

	const addresses: string[] = []
	for (const entry of results) {
		if (
			!allowPrivateNetwork &&
			!isExplicitAllowed &&
			isPrivateIpAddress(entry.address)
		) {
			throw new SsrFBlockedError(
				'Blocked: resolves to private/internal IP address'
			)
		}
		addresses.push(entry.address)
	}

	return addresses
}
