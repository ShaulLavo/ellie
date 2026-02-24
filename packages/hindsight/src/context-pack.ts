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

// ── Token estimation ────────────────────────────────────────────────────────

/**
 * Estimate token count for a string (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface PackCandidate {
  id: string
  content: string
  gist: string | null
  score: number
}

export interface PackedMemory {
  id: string
  text: string
  mode: "full" | "gist"
  score: number
  tokens: number
}

export interface PackResult {
  packed: PackedMemory[]
  overflow: boolean
  totalTokensUsed: number
  budgetRemaining: number
}

// ── Core packer ─────────────────────────────────────────────────────────────

/**
 * Pack ranked candidates into a token budget.
 *
 * @param candidates - Ranked candidates (highest score first)
 * @param tokenBudget - Maximum token budget
 */
export function packContext(
  candidates: PackCandidate[],
  tokenBudget: number,
): PackResult {
  if (candidates.length === 0) {
    return { packed: [], overflow: false, totalTokensUsed: 0, budgetRemaining: tokenBudget }
  }

  const packed: PackedMemory[] = []
  let totalUsed = 0

  // Step 1: Always include full text for top 2
  const top2 = candidates.slice(0, 2)
  let top2Tokens = 0
  for (const c of top2) {
    const tokens = estimateTokens(c.content)
    top2Tokens += tokens
  }

  // Step 7: If top 2 exceed budget, return them anyway with overflow=true
  if (top2Tokens > tokenBudget) {
    for (const c of top2) {
      const tokens = estimateTokens(c.content)
      packed.push({
        id: c.id,
        text: c.content,
        mode: "full",
        score: c.score,
        tokens,
      })
      totalUsed += tokens
    }
    return {
      packed,
      overflow: true,
      totalTokensUsed: totalUsed,
      budgetRemaining: Math.max(0, tokenBudget - totalUsed),
    }
  }

  // Add top 2 to packed
  for (const c of top2) {
    const tokens = estimateTokens(c.content)
    packed.push({
      id: c.id,
      text: c.content,
      mode: "full",
      score: c.score,
      tokens,
    })
    totalUsed += tokens
  }

  // Step 2-4: Compute remaining budget and allocations
  const remaining = candidates.slice(2)
  if (remaining.length === 0) {
    return {
      packed,
      overflow: false,
      totalTokensUsed: totalUsed,
      budgetRemaining: tokenBudget - totalUsed,
    }
  }

  const R = Math.max(0, tokenBudget - top2Tokens)
  let gistBudget = Math.floor(0.70 * R)
  let fullBackfillBudget = R - gistBudget

  // Step 5: Fill gist slots first, then full backfill
  let gistUsed = 0
  let fullUsed = 0
  const gistSlots: PackedMemory[] = []
  const fullBackfillSlots: PackedMemory[] = []
  const skippedForBackfill: PackCandidate[] = []

  for (const c of remaining) {
    const gistText = c.gist ?? generateFallbackGist(c.content)
    const gistTokens = estimateTokens(gistText)
    const fullTokens = estimateTokens(c.content)

    if (gistUsed + gistTokens <= gistBudget) {
      gistSlots.push({
        id: c.id,
        text: gistText,
        mode: "gist",
        score: c.score,
        tokens: gistTokens,
      })
      gistUsed += gistTokens
    } else {
      // Try full backfill
      if (fullUsed + fullTokens <= fullBackfillBudget) {
        fullBackfillSlots.push({
          id: c.id,
          text: c.content,
          mode: "full",
          score: c.score,
          tokens: fullTokens,
        })
        fullUsed += fullTokens
      } else {
        skippedForBackfill.push(c)
      }
    }
  }

  // Step 6: If one bucket underuses, allow the other to consume remainder
  const gistRemaining = gistBudget - gistUsed
  const fullRemaining = fullBackfillBudget - fullUsed

  if (gistRemaining > 0 && skippedForBackfill.length > 0) {
    // Use extra gist budget for full backfill of skipped items
    let extraBudget = gistRemaining
    for (const c of skippedForBackfill) {
      const fullTokens = estimateTokens(c.content)
      if (fullTokens <= extraBudget) {
        fullBackfillSlots.push({
          id: c.id,
          text: c.content,
          mode: "full",
          score: c.score,
          tokens: fullTokens,
        })
        fullUsed += fullTokens
        extraBudget -= fullTokens
      } else {
        // Try gist instead
        const gistText = c.gist ?? generateFallbackGist(c.content)
        const gistTokens = estimateTokens(gistText)
        if (gistTokens <= extraBudget) {
          gistSlots.push({
            id: c.id,
            text: gistText,
            mode: "gist",
            score: c.score,
            tokens: gistTokens,
          })
          gistUsed += gistTokens
          extraBudget -= gistTokens
        }
      }
    }
  } else if (fullRemaining > 0 && skippedForBackfill.length > 0) {
    // Use extra full budget
    let extraBudget = fullRemaining
    for (const c of skippedForBackfill) {
      const gistText = c.gist ?? generateFallbackGist(c.content)
      const gistTokens = estimateTokens(gistText)
      if (gistTokens <= extraBudget) {
        gistSlots.push({
          id: c.id,
          text: gistText,
          mode: "gist",
          score: c.score,
          tokens: gistTokens,
        })
        gistUsed += gistTokens
        extraBudget -= gistTokens
      }
    }
  }

  // Merge gist and full backfill slots (maintain score order)
  const allExtra = [...gistSlots, ...fullBackfillSlots].sort(
    (a, b) => b.score - a.score,
  )

  for (const slot of allExtra) {
    packed.push(slot)
    totalUsed += slot.tokens
  }

  return {
    packed,
    overflow: false,
    totalTokensUsed: totalUsed,
    budgetRemaining: Math.max(0, tokenBudget - totalUsed),
  }
}

// ── Gist fallback ───────────────────────────────────────────────────────────

/**
 * Deterministic fallback gist: truncate to 280 chars with "...".
 */
export function generateFallbackGist(content: string): string {
  if (content.length <= 280) return content
  return content.slice(0, 277) + "..."
}
