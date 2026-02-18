export const DEFAULT_CURSOR_EPOCH: Date = new Date(`2024-10-09T00:00:00.000Z`)
export const DEFAULT_CURSOR_INTERVAL_SECONDS = 20

const MAX_JITTER_SECONDS = 3600
const MIN_JITTER_SECONDS = 1

export interface CursorOptions {
  intervalSeconds?: number
  epoch?: Date
}

export function calculateCursor(options: CursorOptions = {}): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const epoch = options.epoch ?? DEFAULT_CURSOR_EPOCH

  const now = Date.now()
  const epochMs = epoch.getTime()
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
