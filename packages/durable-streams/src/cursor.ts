export const DEFAULT_CURSOR_EPOCH = 1728432000000 // 2024-10-09T00:00:00.000Z
export const DEFAULT_CURSOR_INTERVAL_SECONDS = 20

// Jitter is intentionally wide (up to 1 hour). It only triggers on collision —
// when two clients poll with the same cursor in the same interval. The large
// window permanently desynchronizes lock-step clients so they never collide
// again, which is the goal for CDN response collapsing at high fanout.
const MAX_JITTER_SECONDS = 3600
const MIN_JITTER_SECONDS = 1

export interface CursorOptions {
  intervalSeconds?: number
  epoch?: number
}

export function calculateCursor(options: CursorOptions = {}): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const epochMs = options.epoch ?? DEFAULT_CURSOR_EPOCH

  const now = Date.now()
  const intervalMs = intervalSeconds * 1000

  const intervalNumber = Math.floor((now - epochMs) / intervalMs)
  return String(intervalNumber)
}

function generateJitterIntervals(intervalSeconds: number): number {
  const jitterSeconds =
    MIN_JITTER_SECONDS +
    Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1))
  return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds))
}

export function generateResponseCursor(
  clientCursor: string | undefined,
  options: CursorOptions = {}
): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const currentCursor = calculateCursor(options)
  const currentInterval = parseInt(currentCursor, 10)

  if (!clientCursor) {
    return currentCursor
  }

  const clientInterval = parseInt(clientCursor, 10)

  if (isNaN(clientInterval) || clientInterval < currentInterval) {
    return currentCursor
  }

  const jitterIntervals = generateJitterIntervals(intervalSeconds)
  return String(clientInterval + jitterIntervals)
}
