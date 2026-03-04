import { mkdirSync } from 'fs'
import { LogFile } from './log'

export type AuditLevel = 'event' | 'trace'

export interface AuditEntry {
	sessionId: string
	type: string
	seq?: number
	runId?: string
	payload: unknown
	ts: number
	level: AuditLevel
}

/**
 * Write-only JSONL audit logger with two tiers:
 *
 *   - `log()`   — level='event', for canonical business events (also written to SQLite)
 *   - `trace()` — level='trace', for operational/observability logs (JSONL only)
 *
 * Writes are best-effort — failures are logged to stderr but never thrown.
 * Each day gets its own log file (`audit-YYYY-MM-DD.jsonl`).
 */
export class AuditLogger {
	readonly #logDir: string
	#currentDay = ''
	#logFile: LogFile | null = null

	constructor(logDir: string) {
		this.#logDir = logDir
		mkdirSync(logDir, { recursive: true })
	}

	/** Tier 1: canonical event (called from EventStore.append after SQLite write). */
	log(entry: Omit<AuditEntry, 'level'>): void {
		this.#write({ ...entry, level: 'event' })
	}

	/** Tier 2: operational trace (JSONL only, no SQLite). */
	trace(entry: Omit<AuditEntry, 'level'>): void {
		this.#write({ ...entry, level: 'trace' })
	}

	#write(entry: AuditEntry): void {
		try {
			const day = new Date(entry.ts)
				.toISOString()
				.slice(0, 10)
			if (day !== this.#currentDay) {
				this.#logFile?.close()
				this.#logFile = new LogFile(
					`${this.#logDir}/audit-${day}.jsonl`
				)
				this.#currentDay = day
			}
			const bytes = new TextEncoder().encode(
				`${JSON.stringify(entry)}\n`
			)
			this.#logFile!.append(bytes)

			const prefix =
				entry.level === 'trace' ? '[trace]' : '[audit-log]'
			const reason =
				entry.level === 'trace' &&
				entry.payload &&
				typeof entry.payload === 'object' &&
				'reason' in entry.payload
					? ` reason=${(entry.payload as Record<string, unknown>).reason}`
					: ''
			console.log(
				`${prefix} ${entry.type} session=${entry.sessionId}${entry.runId ? ` run=${entry.runId}` : ''} seq=${entry.seq ?? '-'}${reason}`
			)
		} catch (err) {
			console.error('[audit-log] write failed:', err)
		}
	}

	close(): void {
		this.#logFile?.close()
		this.#logFile = null
		this.#currentDay = ''
	}
}
