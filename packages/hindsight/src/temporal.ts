import * as chrono from 'chrono-node'

/**
 * Temporal extraction from natural language queries.
 *
 * Python parity flow:
 * 1) Period extraction first (deterministic phrase handling)
 * 2) Fallback parser pass (chrono) with false-positive filtering
 */

function startOfDay(date: Date): Date {
	const value = new Date(date)
	value.setHours(0, 0, 0, 0)
	return value
}

function endOfDay(date: Date): Date {
	const value = new Date(date)
	value.setHours(23, 59, 59, 999)
	return value
}

function addDays(date: Date, days: number): Date {
	const value = new Date(date)
	value.setDate(value.getDate() + days)
	return value
}

function range(
	from: Date,
	to: Date
): { from: number; to: number } {
	return {
		from: startOfDay(from).getTime(),
		to: endOfDay(to).getTime()
	}
}

function dayRange(
	referenceDate: Date,
	fromDays: number,
	toDays: number = fromDays
): { from: number; to: number } {
	return range(
		addDays(referenceDate, fromDays),
		addDays(referenceDate, toDays)
	)
}

function getLastWeekday(
	referenceDate: Date,
	weekday: number
): Date {
	const currentWeekday = referenceDate.getDay()
	let diff = (currentWeekday - weekday + 7) % 7
	if (diff === 0) diff = 7
	return addDays(referenceDate, -diff)
}

function lastWeekRange(referenceDate: Date): {
	from: number
	to: number
} {
	const mondayOffset =
		referenceDate.getDay() === 0
			? -6
			: 1 - referenceDate.getDay()
	const thisWeekMonday = addDays(
		referenceDate,
		mondayOffset
	)
	const lastWeekMonday = addDays(thisWeekMonday, -7)
	return range(lastWeekMonday, addDays(lastWeekMonday, 6))
}

function monthRange(
	year: number,
	monthIndexZeroBased: number
): { from: number; to: number } {
	const start = new Date(year, monthIndexZeroBased, 1)
	const end = new Date(year, monthIndexZeroBased + 1, 0)
	return range(start, end)
}

function lastMonthRange(referenceDate: Date): {
	from: number
	to: number
} {
	const year =
		referenceDate.getMonth() === 0
			? referenceDate.getFullYear() - 1
			: referenceDate.getFullYear()
	const month =
		referenceDate.getMonth() === 0
			? 11
			: referenceDate.getMonth() - 1
	return monthRange(year, month)
}

function lastYearRange(referenceDate: Date): {
	from: number
	to: number
} {
	const year = referenceDate.getFullYear() - 1
	return range(new Date(year, 0, 1), new Date(year, 11, 31))
}

const MONTH_PATTERNS: Array<{
	pattern: RegExp
	month: number
}> = [
	{
		pattern: /^(?:january|enero|gennaio|janvier|januar)$/i,
		month: 0
	},
	{
		pattern:
			/^(?:february|febrero|febbraio|fevrier|f[ée]vrier|februar)$/i,
		month: 1
	},
	{
		pattern: /^(?:march|marzo|mars|maerz|m[äa]rz)$/i,
		month: 2
	},
	{ pattern: /^(?:april|abril|aprile|avril)$/i, month: 3 },
	{ pattern: /^(?:may|mayo|maggio|mai)$/i, month: 4 },
	{
		pattern: /^(?:june|junio|giugno|juin|juni)$/i,
		month: 5
	},
	{
		pattern: /^(?:july|julio|luglio|juillet|juli)$/i,
		month: 6
	},
	{
		pattern: /^(?:august|agosto|aout|ao[uû]t)$/i,
		month: 7
	},
	{
		pattern:
			/^(?:september|septiembre|settembre|septembre)$/i,
		month: 8
	},
	{
		pattern:
			/^(?:october|octubre|ottobre|octobre|oktober)$/i,
		month: 9
	},
	{
		pattern: /^(?:november|noviembre|novembre)$/i,
		month: 10
	},
	{
		pattern:
			/^(?:december|diciembre|dicembre|decembre|d[ée]cembre|dezember)$/i,
		month: 11
	}
]

const WEEKDAY_BY_NAME: Record<string, number> = {
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
	sunday: 0
}

function extractMonthYearRange(
	query: string
): { from: number; to: number } | undefined {
	const match = query.match(
		/\b([a-zA-Z\u00C0-\u024F]+)\s+(\d{4})\b/u
	)
	if (!match) return undefined

	const monthName = match[1]!
	const year = Number.parseInt(match[2]!, 10)
	if (!Number.isFinite(year)) return undefined

	const monthPattern = MONTH_PATTERNS.find(entry =>
		entry.pattern.test(monthName)
	)
	if (!monthPattern) return undefined

	return monthRange(year, monthPattern.month)
}

function extractLastWeekdayRange(
	queryLower: string,
	referenceDate: Date
): { from: number; to: number } | undefined {
	const weekdayMatch = queryLower.match(
		/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/
	)
	if (!weekdayMatch) return undefined
	const weekday = WEEKDAY_BY_NAME[weekdayMatch[1]!]
	if (weekday == null) return undefined
	const date = getLastWeekday(referenceDate, weekday)
	return range(date, date)
}

function extractPeriod(
	query: string,
	referenceDate: Date
): { from: number; to: number } | undefined {
	const queryLower = query.toLowerCase()

	const patterns: Array<{
		regex: RegExp
		range: (match: RegExpMatchArray) => {
			from: number
			to: number
		}
	}> = [
		{
			regex: /\b(yesterday|ayer|ieri|hier|gestern)\b/i,
			range: () => dayRange(referenceDate, -1)
		},
		{
			regex: /\b(today|hoy|oggi|heute|aujourd['’]?hui)\b/i,
			range: () => dayRange(referenceDate, 0)
		},
		{
			regex:
				/\b(tomorrow|ma[ñn]ana|domani|morgen|demain)\b/i,
			range: () => dayRange(referenceDate, 1)
		},
		{
			regex: /\blast\s+night\b/i,
			range: () => dayRange(referenceDate, -1)
		},
		{
			regex:
				/\b(last\s+week|la\s+semana\s+pasada|la\s+settimana\s+scorsa|letzte\s+woche)\b/i,
			range: () => lastWeekRange(referenceDate)
		},
		{
			regex:
				/\b(last\s+month|el\s+mes\s+pasado|il\s+mese\s+scorso|letzten?\s+monat)\b/i,
			range: () => lastMonthRange(referenceDate)
		},
		{
			regex:
				/\b(last\s+year|el\s+a[ñn]o\s+pasado|l['’]anno\s+scorso|letztes?\s+jahr)\b/i,
			range: () => lastYearRange(referenceDate)
		},
		{
			regex:
				/\b(last\s+weekend|el\s+fin\s+de\s+semana\s+pasado|letztes?\s+wochenende)\b/i,
			range: () => {
				const saturday = getLastWeekday(referenceDate, 6)
				return range(saturday, addDays(saturday, 1))
			}
		},
		{
			regex: /\b(a\s+)?couple\s+(of\s+)?days?\s+ago\b/i,
			range: () => dayRange(referenceDate, -3, -1)
		},
		{
			regex: /\b(a\s+)?few\s+days?\s+ago\b/i,
			range: () => dayRange(referenceDate, -5, -2)
		},
		{
			regex: /\b(a\s+)?couple\s+(of\s+)?weeks?\s+ago\b/i,
			range: () => dayRange(referenceDate, -21, -7)
		},
		{
			regex: /\b(a\s+)?few\s+weeks?\s+ago\b/i,
			range: () => dayRange(referenceDate, -35, -14)
		},
		{
			regex: /\b(a\s+)?couple\s+(of\s+)?months?\s+ago\b/i,
			range: () => dayRange(referenceDate, -90, -30)
		},
		{
			regex: /\b(a\s+)?few\s+months?\s+ago\b/i,
			range: () => dayRange(referenceDate, -150, -60)
		},
		{
			regex: /\blast\s+(\d+)\s+days?\b/i,
			range: match =>
				dayRange(
					referenceDate,
					-Number.parseInt(match[1]!, 10),
					-1
				)
		},
		{
			regex: /\bin\s+the\s+last\s+(\d+)\s+days?\b/i,
			range: match =>
				dayRange(
					referenceDate,
					-Number.parseInt(match[1]!, 10),
					-1
				)
		}
	]

	for (const pattern of patterns) {
		const match = query.match(pattern.regex)
		if (!match) continue
		return pattern.range(match)
	}

	const weekdayRange = extractLastWeekdayRange(
		queryLower,
		referenceDate
	)
	if (weekdayRange) return weekdayRange

	return extractMonthYearRange(query)
}

const FALSE_POSITIVES = new Set([
	'do',
	'may',
	'march',
	'will',
	'can',
	'sat',
	'sun',
	'mon',
	'tue',
	'wed',
	'thu',
	'fri'
])

function extractFallbackDateRange(
	query: string,
	referenceDate: Date
): { from: number; to: number } | undefined {
	const parsed = chrono.parse(query, referenceDate, {
		forwardDate: false
	})
	if (parsed.length === 0) return undefined

	for (const result of parsed) {
		const text = result.text.trim().toLowerCase()
		if (FALSE_POSITIVES.has(text) && text.length <= 5)
			continue
		if (text.length <= 3 && FALSE_POSITIVES.has(text))
			continue

		const date = result.start.date()
		return range(date, date)
	}

	return undefined
}

/**
 * Extract a temporal range from a natural language query.
 *
 * Returns `undefined` when no temporal signal is detected.
 */
export function extractTemporalRange(
	query: string,
	referenceDate?: Date
): { from: number; to: number } | undefined {
	const now = referenceDate ?? new Date()

	// Python parity: period extraction first.
	const period = extractPeriod(query, now)
	if (period) return period

	// Fallback parser pass.
	return extractFallbackDateRange(query, now)
}
