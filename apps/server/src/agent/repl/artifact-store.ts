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
	/** Raw stdout/stderr from the REPL evaluation. */
	raw: string
	/** The code that produced this output. */
	code: string
}

// ── Artifact Store ──────────────────────────────────────────────────────

export class ArtifactStore {
	readonly #dir: string
	#ready: Promise<void>

	constructor(dataDir: string) {
		this.#dir = join(dataDir, 'repl-artifacts')
		this.#ready = mkdir(this.#dir, {
			recursive: true
		}).then(() => {})
	}

	/**
	 * Append a raw output artifact for a session.
	 */
	async append(
		sessionId: string,
		code: string,
		raw: string
	): Promise<Artifact> {
		await this.#ready

		const artifact: Artifact = {
			id: ulid(),
			sessionId,
			timestamp: Date.now(),
			raw,
			code
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
		await this.#ready
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
