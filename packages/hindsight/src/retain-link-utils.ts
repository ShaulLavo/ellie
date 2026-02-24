/**
 * Temporal link utility helpers for retain pipeline.
 *
 * Parity target: hindsight-api/engine/retain/link_utils.py
 */

const MS_PER_HOUR = 60 * 60 * 1000
const JS_DATE_MIN_MS = -8_640_000_000_000_000
const JS_DATE_MAX_MS = 8_640_000_000_000_000

export const TEMPORAL_LINK_WINDOW_HOURS = 24
export const TEMPORAL_LINK_MIN_WEIGHT = 0.3
export const TEMPORAL_LINK_MAX_NEIGHBORS = 10

export type TemporalDateInput = number | Date | null | undefined

export type TemporalLinkTuple = [string, string, 'temporal', number, null]

interface TemporalCandidate {
	id: string
	eventDate: TemporalDateInput
}

function clampTimestamp(ms: number): number {
	if (ms < JS_DATE_MIN_MS) return JS_DATE_MIN_MS
	if (ms > JS_DATE_MAX_MS) return JS_DATE_MAX_MS
	return ms
}

/**
 * Python parity for `_normalize_datetime`.
 *
 * JS Date/timestamp values are inherently comparable; this normalizes
 * supported inputs to epoch milliseconds.
 */
export function normalizeTemporalDate(value: TemporalDateInput): number | null {
	if (value == null) return null
	if (value instanceof Date) {
		const ms = value.getTime()
		return Number.isFinite(ms) ? clampTimestamp(ms) : null
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	return clampTimestamp(value)
}

/**
 * Python parity for `compute_temporal_query_bounds`.
 */
export function computeTemporalQueryBounds(
	newUnits: Record<string, TemporalDateInput>,
	timeWindowHours: number = TEMPORAL_LINK_WINDOW_HOURS
): { minDate: number | null; maxDate: number | null } {
	const normalizedDates = Object.values(newUnits)
		.map((date) => normalizeTemporalDate(date))
		.filter((date): date is number => date != null)

	if (normalizedDates.length === 0) {
		return { minDate: null, maxDate: null }
	}

	const windowMs = timeWindowHours * MS_PER_HOUR
	const minBase = Math.min(...normalizedDates)
	const maxBase = Math.max(...normalizedDates)

	return {
		minDate: clampTimestamp(minBase - windowMs),
		maxDate: clampTimestamp(maxBase + windowMs)
	}
}

export function computeTemporalWeight(distanceMs: number, windowMs: number): number {
	if (windowMs <= 0) return TEMPORAL_LINK_MIN_WEIGHT
	const linearWeight = 1 - distanceMs / windowMs
	return Math.max(TEMPORAL_LINK_MIN_WEIGHT, linearWeight)
}

/**
 * Python parity for `compute_temporal_links`.
 *
 * Important: preserves candidate input order and applies max-neighbors cap
 * after filtering, matching Python's list-slice behavior.
 */
export function computeTemporalLinks(
	newUnits: Record<string, TemporalDateInput>,
	candidates: TemporalCandidate[],
	timeWindowHours: number = TEMPORAL_LINK_WINDOW_HOURS
): TemporalLinkTuple[] {
	if (Object.keys(newUnits).length === 0) return []

	const links: TemporalLinkTuple[] = []
	const windowMs = timeWindowHours * MS_PER_HOUR

	for (const [unitId, unitEventDate] of Object.entries(newUnits)) {
		const normalizedUnitDate = normalizeTemporalDate(unitEventDate)
		if (normalizedUnitDate == null) continue

		const timeLower = clampTimestamp(normalizedUnitDate - windowMs)
		const timeUpper = clampTimestamp(normalizedUnitDate + windowMs)

		const matchingNeighbors: Array<{ id: string; eventDate: number }> = []
		for (const candidate of candidates) {
			const normalizedCandidateDate = normalizeTemporalDate(candidate.eventDate)
			if (normalizedCandidateDate == null) continue
			if (normalizedCandidateDate < timeLower || normalizedCandidateDate > timeUpper) {
				continue
			}
			matchingNeighbors.push({
				id: String(candidate.id),
				eventDate: normalizedCandidateDate
			})
			if (matchingNeighbors.length >= TEMPORAL_LINK_MAX_NEIGHBORS) break
		}

		for (const neighbor of matchingNeighbors) {
			const distanceMs = Math.abs(normalizedUnitDate - neighbor.eventDate)
			const weight = computeTemporalWeight(distanceMs, windowMs)
			links.push([unitId, neighbor.id, 'temporal', weight, null])
		}
	}

	return links
}
