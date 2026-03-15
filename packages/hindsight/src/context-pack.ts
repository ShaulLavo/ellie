/**
 * Context packing policy for token-budget-constrained recall.
 *
 * Given ranked candidates and a budget B:
 * 1. Always include full text for top 2 ranked memories.
 * 2. Compute remaining budget R = max(0, B - top2_full_tokens).
 * 3. Allocate gistBudget = floor(0.70 * R).
 * 4. Allocate fullBackfillBudget = R - gistBudget.
 * 5. From rank 3 onward:
 *    - fill gist slots by score until gistBudget is exhausted.
 *    - then backfill full text by score until fullBackfillBudget is exhausted.
 * 6. If one bucket underuses budget, allow the other bucket to consume the remainder.
 * 7. If top 2 exceed budget, return top 2 full texts only and set overflow=true.
 */

/**
 * Estimate token count for a string (~4 chars per token).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export interface PackCandidate {
	id: string
	content: string
	gist: string | null
	score: number
}

export interface PackedMemory {
	id: string
	text: string
	mode: 'full' | 'gist'
	score: number
	tokens: number
}

export interface PackResult {
	packed: PackedMemory[]
	overflow: boolean
	totalTokensUsed: number
	budgetRemaining: number
}

/**
 * Pack ranked candidates into a token budget.
 *
 * @param candidates - Ranked candidates (highest score first)
 * @param tokenBudget - Maximum token budget
 */
export function packContext(
	candidates: PackCandidate[],
	tokenBudget: number
): PackResult {
	if (candidates.length === 0) {
		return {
			packed: [],
			overflow: false,
			totalTokensUsed: 0,
			budgetRemaining: tokenBudget
		}
	}

	// Step 1 & 7: Always include full text for top 2; overflow if they exceed budget
	const top2 = packTop2Candidates(
		candidates.slice(0, 2),
		tokenBudget
	)
	if (top2.overflow) {
		return {
			packed: top2.entries,
			overflow: true,
			totalTokensUsed: top2.totalTokens,
			budgetRemaining: Math.max(
				0,
				tokenBudget - top2.totalTokens
			)
		}
	}

	const packed: PackedMemory[] = [...top2.entries]
	let totalUsed = top2.totalTokens

	// Steps 2-4: Compute remaining budget and allocations
	const remaining = candidates.slice(2)
	if (remaining.length === 0) {
		return {
			packed,
			overflow: false,
			totalTokensUsed: totalUsed,
			budgetRemaining: tokenBudget - totalUsed
		}
	}

	const R = Math.max(0, tokenBudget - top2.totalTokens)
	const gistBudget = Math.floor(0.7 * R)
	const fullBackfillBudget = R - gistBudget

	// Step 5: Fill gist slots first, then full backfill
	const slots = fillGistAndBackfillSlots(
		remaining,
		gistBudget,
		fullBackfillBudget
	)

	// Step 6: Reallocate leftover budgets between buckets
	reallocateLeftoverBudgets(
		slots,
		gistBudget,
		fullBackfillBudget
	)

	// Merge extra slots (maintain score order)
	const allExtra = [
		...slots.gistSlots,
		...slots.fullBackfillSlots
	].sort((a, b) => b.score - a.score)
	for (const slot of allExtra) {
		packed.push(slot)
		totalUsed += slot.tokens
	}

	return {
		packed,
		overflow: false,
		totalTokensUsed: totalUsed,
		budgetRemaining: Math.max(0, tokenBudget - totalUsed)
	}
}

interface Top2Result {
	entries: PackedMemory[]
	totalTokens: number
	overflow: boolean
}

/**
 * Build PackedMemory entries for the top-2 candidates and detect budget overflow.
 */
function packTop2Candidates(
	top2: PackCandidate[],
	tokenBudget: number
): Top2Result {
	const entries: PackedMemory[] = []
	let totalTokens = 0

	for (const c of top2) {
		const tokens = estimateTokens(c.content)
		entries.push({
			id: c.id,
			text: c.content,
			mode: 'full',
			score: c.score,
			tokens
		})
		totalTokens += tokens
	}

	return {
		entries,
		totalTokens,
		overflow: totalTokens > tokenBudget
	}
}

interface SlotFillResult {
	gistSlots: PackedMemory[]
	fullBackfillSlots: PackedMemory[]
	skipped: PackCandidate[]
	gistUsed: number
	fullUsed: number
}

/**
 * Iterate over remaining candidates, filling gist slots first and full-backfill slots second.
 * Candidates that fit in neither bucket are collected in `skipped`.
 */
function fillGistAndBackfillSlots(
	remaining: PackCandidate[],
	gistBudget: number,
	fullBackfillBudget: number
): SlotFillResult {
	const gistSlots: PackedMemory[] = []
	const fullBackfillSlots: PackedMemory[] = []
	const skipped: PackCandidate[] = []
	let gistUsed = 0
	let fullUsed = 0

	for (const c of remaining) {
		const gistText =
			c.gist ?? generateFallbackGist(c.content)
		const gistTokens = estimateTokens(gistText)
		const fullTokens = estimateTokens(c.content)

		if (gistUsed + gistTokens <= gistBudget) {
			gistSlots.push({
				id: c.id,
				text: gistText,
				mode: 'gist',
				score: c.score,
				tokens: gistTokens
			})
			gistUsed += gistTokens
		} else if (
			fullUsed + fullTokens <=
			fullBackfillBudget
		) {
			fullBackfillSlots.push({
				id: c.id,
				text: c.content,
				mode: 'full',
				score: c.score,
				tokens: fullTokens
			})
			fullUsed += fullTokens
		} else {
			skipped.push(c)
		}
	}

	return {
		gistSlots,
		fullBackfillSlots,
		skipped,
		gistUsed,
		fullUsed
	}
}

/**
 * Reallocate leftover budget from one bucket to the other (Step 6).
 * Mutates slots.gistSlots, slots.fullBackfillSlots, and usage counters.
 */
function reallocateLeftoverBudgets(
	slots: SlotFillResult,
	gistBudget: number,
	fullBackfillBudget: number
): void {
	const gistRemaining = gistBudget - slots.gistUsed
	const fullRemaining = fullBackfillBudget - slots.fullUsed
	const allocatedIds = new Set<string>()

	if (gistRemaining > 0 && slots.skipped.length > 0) {
		const spent = reallocateGistBudget(
			slots.skipped,
			gistRemaining,
			slots.fullBackfillSlots,
			slots.gistSlots,
			allocatedIds
		)
		slots.fullUsed += spent.fullUsed
		slots.gistUsed += spent.gistUsed
	}

	if (fullRemaining > 0 && slots.skipped.length > 0) {
		slots.gistUsed += reallocateFullBudget(
			slots.skipped,
			fullRemaining,
			slots.gistSlots,
			allocatedIds
		)
	}
}

/**
 * Use leftover gist budget to allocate skipped items as full or gist.
 * Returns how many full and gist tokens were consumed.
 */
function reallocateGistBudget(
	skipped: PackCandidate[],
	extraBudget: number,
	fullBackfillSlots: PackedMemory[],
	gistSlots: PackedMemory[],
	allocatedIds: Set<string>
): { fullUsed: number; gistUsed: number } {
	let remaining = extraBudget
	let fullUsed = 0
	let gistUsed = 0

	for (const c of skipped) {
		const fullTokens = estimateTokens(c.content)
		if (fullTokens <= remaining) {
			fullBackfillSlots.push({
				id: c.id,
				text: c.content,
				mode: 'full',
				score: c.score,
				tokens: fullTokens
			})
			fullUsed += fullTokens
			remaining -= fullTokens
			allocatedIds.add(c.id)
			continue
		}
		// Try gist instead
		const gistText =
			c.gist ?? generateFallbackGist(c.content)
		const gistTokens = estimateTokens(gistText)
		if (gistTokens <= remaining) {
			gistSlots.push({
				id: c.id,
				text: gistText,
				mode: 'gist',
				score: c.score,
				tokens: gistTokens
			})
			gistUsed += gistTokens
			remaining -= gistTokens
			allocatedIds.add(c.id)
		}
	}
	return { fullUsed, gistUsed }
}

/**
 * Use leftover full budget for remaining skipped items (gist mode only).
 * Returns how many gist tokens were consumed.
 */
function reallocateFullBudget(
	skipped: PackCandidate[],
	extraBudget: number,
	gistSlots: PackedMemory[],
	allocatedIds: Set<string>
): number {
	let remaining = extraBudget
	let gistUsed = 0

	for (const c of skipped) {
		if (allocatedIds.has(c.id)) continue
		const gistText =
			c.gist ?? generateFallbackGist(c.content)
		const gistTokens = estimateTokens(gistText)
		if (gistTokens > remaining) continue
		gistSlots.push({
			id: c.id,
			text: gistText,
			mode: 'gist',
			score: c.score,
			tokens: gistTokens
		})
		gistUsed += gistTokens
		remaining -= gistTokens
	}
	return gistUsed
}

/**
 * Deterministic fallback gist: truncate to 280 chars with "...".
 */
export function generateFallbackGist(
	content: string
): string {
	if (content.length <= 280) return content
	return content.slice(0, 277) + '...'
}
