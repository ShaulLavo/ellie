/**
 * Temporal extraction from natural language queries.
 *
 * Supports:
 * - Relative periods ("last week", "last month", "last year")
 * - Weekday references ("last saturday")
 * - Weekend references ("last weekend")
 * - Fuzzy phrases ("a couple of days ago", "a few weeks ago")
 * - Month+year ranges ("June 2024", "junio 2024", "giugno 2024")
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

function range(from: Date, to: Date): { from: number; to: number } {
  return {
    from: startOfDay(from).getTime(),
    to: endOfDay(to).getTime(),
  }
}

function dayRange(
  referenceDate: Date,
  fromDays: number,
  toDays: number = fromDays,
): { from: number; to: number } {
  return range(addDays(referenceDate, fromDays), addDays(referenceDate, toDays))
}

function getLastWeekday(referenceDate: Date, weekday: number): Date {
  const currentWeekday = referenceDate.getDay()
  let diff = (currentWeekday - weekday + 7) % 7
  if (diff === 0) diff = 7
  return addDays(referenceDate, -diff)
}

function thisWeekRange(referenceDate: Date): { from: number; to: number } {
  const currentWeekday = referenceDate.getDay()
  const mondayOffset = currentWeekday === 0 ? -6 : 1 - currentWeekday
  const monday = addDays(referenceDate, mondayOffset)
  const sunday = addDays(monday, 6)
  return range(monday, sunday)
}

function lastWeekRange(referenceDate: Date): { from: number; to: number } {
  const thisWeek = thisWeekRange(referenceDate)
  const start = addDays(new Date(thisWeek.from), -7)
  const end = addDays(new Date(thisWeek.to), -7)
  return range(start, end)
}

function monthRange(year: number, monthIndexZeroBased: number): { from: number; to: number } {
  const start = new Date(year, monthIndexZeroBased, 1)
  const end = new Date(year, monthIndexZeroBased + 1, 0)
  return range(start, end)
}

function lastMonthRange(referenceDate: Date): { from: number; to: number } {
  const year = referenceDate.getMonth() === 0
    ? referenceDate.getFullYear() - 1
    : referenceDate.getFullYear()
  const month = referenceDate.getMonth() === 0 ? 11 : referenceDate.getMonth() - 1
  return monthRange(year, month)
}

function thisMonthRange(referenceDate: Date): { from: number; to: number } {
  return monthRange(referenceDate.getFullYear(), referenceDate.getMonth())
}

function lastYearRange(referenceDate: Date): { from: number; to: number } {
  const year = referenceDate.getFullYear() - 1
  return range(new Date(year, 0, 1), new Date(year, 11, 31))
}

const MONTH_PATTERNS: Array<{ pattern: RegExp; month: number }> = [
  { pattern: /^(?:january|enero|gennaio|janvier|januar)$/i, month: 0 },
  { pattern: /^(?:february|febrero|febbraio|fevrier|f[ée]vrier|februar)$/i, month: 1 },
  { pattern: /^(?:march|marzo|mars|maerz|m[äa]rz)$/i, month: 2 },
  { pattern: /^(?:april|abril|aprile|avril)$/i, month: 3 },
  { pattern: /^(?:may|mayo|maggio|mai)$/i, month: 4 },
  { pattern: /^(?:june|junio|giugno|juin|juni)$/i, month: 5 },
  { pattern: /^(?:july|julio|luglio|juillet|juli)$/i, month: 6 },
  { pattern: /^(?:august|agosto|aout|ao[uû]t)$/i, month: 7 },
  { pattern: /^(?:september|septiembre|settembre|septembre)$/i, month: 8 },
  { pattern: /^(?:october|octubre|ottobre|octobre|oktober)$/i, month: 9 },
  { pattern: /^(?:november|noviembre|novembre)$/i, month: 10 },
  { pattern: /^(?:december|diciembre|dicembre|decembre|d[ée]cembre|dezember)$/i, month: 11 },
]

const WEEKDAY_BY_NAME: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
}

function extractMonthYearRange(query: string): { from: number; to: number } | undefined {
  const match = query.match(
    /\b([a-zA-Z\u00C0-\u024F]+)\s+(\d{4})\b/u,
  )
  if (!match) return undefined

  const monthName = match[1]!
  const year = Number.parseInt(match[2]!, 10)
  if (!Number.isFinite(year)) return undefined

  const monthPattern = MONTH_PATTERNS.find((entry) => entry.pattern.test(monthName))
  if (!monthPattern) return undefined

  return monthRange(year, monthPattern.month)
}

function extractLastWeekdayRange(
  queryLower: string,
  referenceDate: Date,
): { from: number; to: number } | undefined {
  const weekdayMatch = queryLower.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)
  if (!weekdayMatch) return undefined
  const weekday = WEEKDAY_BY_NAME[weekdayMatch[1]!]
  if (weekday == null) return undefined
  const date = getLastWeekday(referenceDate, weekday)
  return range(date, date)
}

const PERIOD_PATTERNS: Array<{
  regex: RegExp
  range: (referenceDate: Date, match: RegExpMatchArray) => { from: number; to: number }
}> = [
  {
    regex: /\b(yesterday|ayer|ieri|hier|gestern)\b/i,
    range: (referenceDate) => dayRange(referenceDate, -1),
  },
  {
    regex: /\b(today|hoy|oggi|heute|aujourd['’]?hui)\b/i,
    range: (referenceDate) => dayRange(referenceDate, 0),
  },
  {
    regex: /\b(last\s+week|la\s+semana\s+pasada|la\s+settimana\s+scorsa|letzte\s+woche)\b/i,
    range: (referenceDate) => lastWeekRange(referenceDate),
  },
  {
    regex: /\b(this\s+week)\b/i,
    range: (referenceDate) => thisWeekRange(referenceDate),
  },
  {
    regex: /\b(last\s+month|el\s+mes\s+pasado|il\s+mese\s+scorso|letzten?\s+monat)\b/i,
    range: (referenceDate) => lastMonthRange(referenceDate),
  },
  {
    regex: /\b(this\s+month)\b/i,
    range: (referenceDate) => thisMonthRange(referenceDate),
  },
  {
    regex: /\b(last\s+year|el\s+a[ñn]o\s+pasado|l['’]anno\s+scorso|letztes?\s+jahr)\b/i,
    range: (referenceDate) => lastYearRange(referenceDate),
  },
  {
    regex: /\b(last\s+weekend|el\s+fin\s+de\s+semana\s+pasado|letztes?\s+wochenende)\b/i,
    range: (referenceDate) => {
      const saturday = getLastWeekday(referenceDate, 6)
      return range(saturday, addDays(saturday, 1))
    },
  },
  {
    regex: /\b(a\s+)?couple\s+(of\s+)?days?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -3, -1),
  },
  {
    regex: /\b(a\s+)?few\s+days?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -5, -2),
  },
  {
    regex: /\b(a\s+)?couple\s+(of\s+)?weeks?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -21, -7),
  },
  {
    regex: /\b(a\s+)?few\s+weeks?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -35, -14),
  },
  {
    regex: /\b(a\s+)?couple\s+(of\s+)?months?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -90, -30),
  },
  {
    regex: /\b(a\s+)?few\s+months?\s+ago\b/i,
    range: (referenceDate) => dayRange(referenceDate, -150, -60),
  },
  {
    regex: /\blast\s+(\d+)\s+days?\b/i,
    range: (referenceDate, match) => {
      const days = Number.parseInt(match[1]!, 10)
      return dayRange(referenceDate, -days, -1)
    },
  },
  {
    regex: /\bin\s+the\s+last\s+(\d+)\s+days?\b/i,
    range: (referenceDate, match) => {
      const days = Number.parseInt(match[1]!, 10)
      return dayRange(referenceDate, -days, -1)
    },
  },
]

/**
 * Extract a temporal range from a natural language query.
 *
 * Returns `undefined` when no temporal signal is detected.
 */
export function extractTemporalRange(
  query: string,
  referenceDate?: Date,
): { from: number; to: number } | undefined {
  const now = referenceDate ?? new Date()
  const queryLower = query.toLowerCase()

  const monthYearRange = extractMonthYearRange(query)
  if (monthYearRange) return monthYearRange

  const lastWeekdayRange = extractLastWeekdayRange(queryLower, now)
  if (lastWeekdayRange) return lastWeekdayRange

  for (const pattern of PERIOD_PATTERNS) {
    const match = query.match(pattern.regex)
    if (!match) continue
    return pattern.range(now, match)
  }

  return undefined
}
