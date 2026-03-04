import { mkdirSync } from 'fs'
import { LogFile } from './log'

export interface AuditEntry {
	sessionId: string
	type: string
	seq?: number
	runId?: string
	payload: unknown
	ts: number
}

/**
 * Write-only JSONL audit logger.
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

	log(entry: AuditEntry): void {
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
			if (process.env.DEBUG_AUDIT_LOG === 'true') {
				console.log(
					`[audit-log] ${entry.type} session=${entry.sessionId}${entry.runId ? ` run=${entry.runId}` : ''} seq=${entry.seq ?? '-'}`,
					JSON.stringify(entry.payload, null, 2)
				)
			}
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
