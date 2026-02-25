/**
 * Working Memory — runtime-only per-session boost layer.
 *
 * Tracks recently-accessed memory IDs per session, providing a recency
 * boost in cognitive mode. Not persisted to disk.
 *
 * Key: bankId → sessionId → WmEntry[]
 * Capacity: 40 unique IDs per session
 * Decay: 15 minutes (900,000 ms)
 * Max boost: 0.20
 */

// ── Constants ──────────────────────────────────────────────────────────────

const WM_CAPACITY = 40
const WM_DECAY_MS = 900_000 // 15 minutes

// ── Types ──────────────────────────────────────────────────────────────────

interface WmEntry {
	memoryId: string
	touchedAt: number
}

// ── Working Memory Store ───────────────────────────────────────────────────

export class WorkingMemoryStore {
	/** Two-level map: bankId → sessionId → entries (avoids delimiter collisions) */
	private readonly store = new Map<string, Map<string, WmEntry[]>>()

	/**
	 * Touch (add or update) memory IDs in working memory for a session.
	 */
	touch(bankId: string, sessionId: string, memoryIds: string[], now: number): void {
		let sessions = this.store.get(bankId)
		if (!sessions) {
			sessions = new Map()
			this.store.set(bankId, sessions)
		}
		let entries = sessions.get(sessionId) ?? []

		// Remove expired entries lazily
		entries = entries.filter((e) => now - e.touchedAt < WM_DECAY_MS)

		// Update existing or add new
		const existingIds = new Map(entries.map((e) => [e.memoryId, e]))
		for (const memoryId of memoryIds) {
			existingIds.set(memoryId, { memoryId, touchedAt: now })
		}

		// Convert back to array
		entries = [...existingIds.values()]

		// Sort by touchedAt ascending (oldest first) for LRU eviction
		entries.sort((a, b) => a.touchedAt - b.touchedAt)

		// Evict LRU if over capacity
		if (entries.length > WM_CAPACITY) {
			entries = entries.slice(entries.length - WM_CAPACITY)
		}

		// Clean up empty session keys to prevent unbounded accumulation
		if (entries.length === 0) {
			sessions.delete(sessionId)
			if (sessions.size === 0) this.store.delete(bankId)
		} else {
			sessions.set(sessionId, entries)
		}
	}

	/**
	 * Compute working memory boost for a given memory ID.
	 *
	 * boost = 0.20 * exp(-ageMs / decayMs) when entry exists and not expired.
	 * Returns 0 if not found or expired.
	 */
	getBoost(bankId: string, sessionId: string, memoryId: string, now: number): number {
		const entries = this.store.get(bankId)?.get(sessionId)
		if (!entries) return 0

		const entry = entries.find((e) => e.memoryId === memoryId)
		if (!entry) return 0

		const ageMs = now - entry.touchedAt
		if (ageMs >= WM_DECAY_MS) return 0

		return 0.2 * Math.exp(-ageMs / WM_DECAY_MS)
	}

	/**
	 * Get all active (non-expired) entries for a session.
	 */
	getEntries(bankId: string, sessionId: string, now: number): WmEntry[] {
		const sessions = this.store.get(bankId)
		if (!sessions) return []
		const entries = sessions.get(sessionId)
		if (!entries) return []

		const active = entries.filter((e) => now - e.touchedAt < WM_DECAY_MS)

		// Lazy cleanup: update store if we filtered out expired entries
		if (active.length !== entries.length) {
			if (active.length === 0) {
				sessions.delete(sessionId)
				if (sessions.size === 0) this.store.delete(bankId)
			} else {
				sessions.set(sessionId, active)
			}
		}

		return active
	}

	/**
	 * Clear all working memory (useful for testing).
	 */
	clear(): void {
		this.store.clear()
	}
}
