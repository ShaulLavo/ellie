// Monotonic ULID implementation:
// - Lexicographically increasing even for multiple IDs in the same millisecond
// - Monotonic under clock rollback by pinning to the last emitted timestamp
// - `createUlid()` provides isolated state so callers can create one generator per Worker

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_DIGITS = 16
const MAX_DIGIT = 31
const BATCH = 8192

interface UlidState {
	lastTimestamp: number
	lastRandom: Uint8Array<ArrayBuffer>
	randomPool: Uint8Array<ArrayBuffer>
	randomPoolPos: number
	outBuf: Uint8Array<ArrayBuffer>
	decoder: TextDecoder
}

const ENC = new Uint8Array(32)
for (let i = 0; i < 32; i++) ENC[i] = ENCODING.charCodeAt(i)

function fillRandomPool(state: UlidState): void {
	crypto.getRandomValues(state.randomPool)
	state.randomPoolPos = 0
}

function setRandomFromPool(state: UlidState): void {
	if (state.randomPoolPos >= BATCH) fillRandomPool(state)

	const poolOffset = state.randomPoolPos * RANDOM_DIGITS
	state.randomPoolPos += 1

	for (let i = 0; i < RANDOM_DIGITS; i++) {
		const digit =
			state.randomPool[poolOffset + i] & MAX_DIGIT
		state.lastRandom[i] = digit
		state.outBuf[10 + i] = ENC[digit]
	}
}

function incrementRandom(state: UlidState): boolean {
	const random = state.lastRandom
	const out = state.outBuf
	for (let i = RANDOM_DIGITS - 1; i >= 0; i--) {
		const value = random[i]
		if (value < MAX_DIGIT) {
			const next = value + 1
			random[i] = next
			out[10 + i] = ENC[next]
			return true
		}

		random[i] = 0
		out[10 + i] = ENC[0]
	}

	return false
}

function nextTimestamp(previousTimestamp: number): number {
	let timestamp = Date.now()
	if (timestamp > previousTimestamp) return timestamp

	while (timestamp <= previousTimestamp) {
		timestamp = Date.now()
	}

	return timestamp
}

function setTimestamp(
	out: Uint8Array,
	timestamp: number
): void {
	// 10 chars of timestamp (48 bits, 5 bits per char, Crockford base32, MSB first).
	// Divisors are exact powers of 2, so Math.floor division is float-precise.
	out[0] =
		ENC[Math.floor(timestamp / 35184372088832) & MAX_DIGIT] // 2^45
	out[1] =
		ENC[Math.floor(timestamp / 1099511627776) & MAX_DIGIT] // 2^40
	out[2] =
		ENC[Math.floor(timestamp / 34359738368) & MAX_DIGIT] // 2^35
	out[3] =
		ENC[Math.floor(timestamp / 1073741824) & MAX_DIGIT] // 2^30
	out[4] = ENC[Math.floor(timestamp / 33554432) & MAX_DIGIT] // 2^25
	out[5] = ENC[Math.floor(timestamp / 1048576) & MAX_DIGIT] // 2^20
	out[6] = ENC[Math.floor(timestamp / 32768) & MAX_DIGIT] // 2^15
	out[7] = ENC[Math.floor(timestamp / 1024) & MAX_DIGIT] // 2^10
	out[8] = ENC[Math.floor(timestamp / 32) & MAX_DIGIT] // 2^5
	out[9] = ENC[timestamp & MAX_DIGIT] // 2^0
}

function nextMonotonicTimestamp(
	lastTimestamp: number,
	now: number
): number {
	if (now > lastTimestamp) return now
	return lastTimestamp
}

export function createUlid(): () => string {
	const state: UlidState = {
		lastTimestamp: -1,
		lastRandom: new Uint8Array(RANDOM_DIGITS),
		randomPool: new Uint8Array(BATCH * RANDOM_DIGITS),
		randomPoolPos: BATCH,
		outBuf: new Uint8Array(26),
		decoder: new TextDecoder()
	}

	return function ulidFromState(): string {
		const timestamp = nextMonotonicTimestamp(
			state.lastTimestamp,
			Date.now()
		)
		if (timestamp > state.lastTimestamp) {
			state.lastTimestamp = timestamp
			setTimestamp(state.outBuf, state.lastTimestamp)
			setRandomFromPool(state)
			return state.decoder.decode(state.outBuf)
		}

		if (incrementRandom(state)) {
			return state.decoder.decode(state.outBuf)
		}

		state.lastTimestamp = nextTimestamp(state.lastTimestamp)
		setTimestamp(state.outBuf, state.lastTimestamp)
		setRandomFromPool(state)
		return state.decoder.decode(state.outBuf)
	}
}

export const ulid = createUlid()
