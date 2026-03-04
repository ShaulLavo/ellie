/**
 * Artifact store — store raw REPL outputs for audit/debug.
 *
 * Raw stdout/stderr from session_exec calls are NOT injected into
 * the model context. Instead they are stored here as artifacts that
 * can be inspected on demand.
 */

import {
	mkdir,
	appendFile,
	readFile,
	access
} from 'fs/promises'
import { join } from 'path'
import { ulid } from 'fast-ulid'

// ── Types ───────────────────────────────────────────────────────────────

export interface Artifact {
	id: string
	sessionId: string
	timestamp: number
	/** The code that was executed. */
	code: string
	/** Committed output (from print() calls). */
	committed: string
	/** Raw stdout/stderr from the REPL evaluation. */
	raw: string
	/** Whether execution produced an error. */
	isError: boolean
	/** Error message if isError is true. */
	errorMessage?: string
	/** Wall-clock execution time in ms. */
	elapsedMs: number
}

// ── Artifact Store ──────────────────────────────────────────────────────

export class ArtifactStore {
	readonly #dir: string

	constructor(dataDir: string) {
		this.#dir = join(dataDir, 'repl-artifacts')
	}

	async #ensureDir(): Promise<void> {
		await mkdir(this.#dir, { recursive: true })
	}

	/**
	 * Append a full execution trace for a session.
	 */
	async append(
		sessionId: string,
		entry: Omit<Artifact, 'id' | 'sessionId' | 'timestamp'>
	): Promise<Artifact> {
		await this.#ensureDir()

		const artifact: Artifact = {
			id: ulid(),
			sessionId,
			timestamp: Date.now(),
			...entry
		}

		const path = this.#artifactPath(sessionId)
		const line = JSON.stringify(artifact) + '\n'
		await appendFile(path, line, 'utf-8')

		return artifact
	}

	/**
	 * Read all artifacts for a session (JSONL format).
	 */
	async list(sessionId: string): Promise<Artifact[]> {
		await this.#ensureDir()
		const path = this.#artifactPath(sessionId)

		try {
			await access(path)
		} catch {
			return []
		}

		try {
			const raw = await readFile(path, 'utf-8')
			return raw
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line) as Artifact)
		} catch {
			return []
		}
	}

	// ── Private ──────────────────────────────────────────────────────────

	#artifactPath(sessionId: string): string {
		const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
		return join(this.#dir, `${safe}.jsonl`)
	}
}
