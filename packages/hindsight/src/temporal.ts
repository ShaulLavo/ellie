/**
 * Regex-based temporal extraction from natural language queries.
 *
 * Ported from the original Hindsight's pattern-based approach.
 * Detects phrases like "yesterday", "last week", "in the last 30 days"
 * and converts them to epoch-ms time ranges.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function dayRange(
  now: Date,
  fromDays: number,
  toDays?: number,
): { from: number; to: number } {
  return {
    from: startOfDay(addDays(now, fromDays)).getTime(),
    to: endOfDay(addDays(now, toDays ?? 0)).getTime(),
  }
}

// ── Patterns ────────────────────────────────────────────────────────────────

type RangeFn = (now: Date, match: RegExpMatchArray) => { from: number; to: number }

const TEMPORAL_PATTERNS: Array<[RegExp, RangeFn]> = [
  [/\blast\s+night\b/i, (now) => dayRange(now, -1, -1)],
  [/\byesterday\b/i, (now) => dayRange(now, -1, -1)],
  [/\btoday\b/i, (now) => dayRange(now, 0, 0)],
  [/\bthis\s+morning\b/i, (now) => dayRange(now, 0, 0)],
  [/\btomorrow\b/i, (now) => dayRange(now, 1, 1)],
  [/\blast\s+week\b/i, (now) => dayRange(now, -7, -1)],
  [/\bthis\s+week\b/i, (now) => dayRange(now, -3, 3)],
  [/\bnext\s+week\b/i, (now) => dayRange(now, 1, 7)],
  [/\blast\s+month\b/i, (now) => dayRange(now, -30, -1)],
  [/\bthis\s+month\b/i, (now) => dayRange(now, -15, 15)],
  [/\bnext\s+month\b/i, (now) => dayRange(now, 1, 30)],
  [
    /\blast\s+(\d+)\s+days?\b/i,
    (now, m) => dayRange(now, -parseInt(m[1]!, 10)),
  ],
  [
    /\bin\s+the\s+last\s+(\d+)\s+days?\b/i,
    (now, m) => dayRange(now, -parseInt(m[1]!, 10)),
  ],
  [
    /\blast\s+(\d+)\s+weeks?\b/i,
    (now, m) => dayRange(now, -parseInt(m[1]!, 10) * 7),
  ],
  [
    /\blast\s+(\d+)\s+months?\b/i,
    (now, m) => dayRange(now, -parseInt(m[1]!, 10) * 30),
  ],
]

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Extract a temporal range from a natural language query.
 *
 * Returns `undefined` if no temporal phrase is detected, so the caller
 * can fall back to the default behavior (no time filter).
 */
export function extractTemporalRange(
  query: string,
  referenceDate?: Date,
): { from: number; to: number } | undefined {
  const now = referenceDate ?? new Date()
  for (const [pattern, rangeFn] of TEMPORAL_PATTERNS) {
    const match = query.match(pattern)
    if (match) return rangeFn(now, match)
  }
  return undefined
}
