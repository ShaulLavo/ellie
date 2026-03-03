/**
 * Snapshot store — persist and restore REPL session state.
 *
 * Snapshots are keyed by (sessionId, workspaceDir, gitHead) so
 * that state is only restored when the execution context is
 * compatible.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync
} from 'fs'
import { join } from 'path'

// ── Types ───────────────────────────────────────────────────────────────

export interface SnapshotMetadata {
	sessionId: string
	workspaceDir: string
	gitHead: string | null
	savedAt: number
	version: number
}

export interface Snapshot {
	metadata: SnapshotMetadata
	/** Serializable global state from the REPL. */
	globals: Record<string, unknown>
}

// ── Constants ───────────────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1

// ── Snapshot Store ──────────────────────────────────────────────────────

export class SnapshotStore {
	readonly #dir: string

	constructor(dataDir: string) {
		this.#dir = join(dataDir, 'repl-snapshots')
		if (!existsSync(this.#dir)) {
			mkdirSync(this.#dir, { recursive: true })
		}
	}

	/**
	 * Save a snapshot of REPL state.
	 */
	save(
		sessionId: string,
		workspaceDir: string,
		gitHead: string | null,
		globals: Record<string, unknown>
	): SnapshotMetadata {
		const metadata: SnapshotMetadata = {
			sessionId,
			workspaceDir,
			gitHead,
			savedAt: Date.now(),
			version: SNAPSHOT_VERSION
		}

		const snapshot: Snapshot = { metadata, globals }
		const path = this.#snapshotPath(sessionId)

		writeFileSync(path, JSON.stringify(snapshot), 'utf-8')

		return metadata
	}

	/**
	 * Restore a snapshot if compatible with current context.
	 *
	 * Returns null if:
	 *   - No snapshot exists for this session.
	 *   - Workspace directory doesn't match.
	 *   - Git HEAD doesn't match (if both are available).
	 *   - Snapshot version is incompatible.
	 */
	restore(
		sessionId: string,
		workspaceDir: string,
		gitHead: string | null
	): Snapshot | null {
		const path = this.#snapshotPath(sessionId)

		if (!existsSync(path)) return null

		try {
			const raw = readFileSync(path, 'utf-8')
			const snapshot = JSON.parse(raw) as Snapshot

			// Version check
			if (snapshot.metadata.version !== SNAPSHOT_VERSION) {
				console.warn(
					`[snapshot-store] incompatible version for session=${sessionId}: found=${snapshot.metadata.version} expected=${SNAPSHOT_VERSION}`
				)
				return null
			}

			// Workspace check
			if (snapshot.metadata.workspaceDir !== workspaceDir) {
				console.warn(
					`[snapshot-store] workspace mismatch for session=${sessionId}: saved=${snapshot.metadata.workspaceDir} current=${workspaceDir}`
				)
				return null
			}

			// Git HEAD check (both must be available and match)
			if (
				gitHead &&
				snapshot.metadata.gitHead &&
				snapshot.metadata.gitHead !== gitHead
			) {
				console.warn(
					`[snapshot-store] git HEAD mismatch for session=${sessionId}: saved=${snapshot.metadata.gitHead} current=${gitHead}`
				)
				return null
			}

			return snapshot
		} catch (err) {
			console.error(
				`[snapshot-store] failed to restore snapshot for session=${sessionId}:`,
				err instanceof Error ? err.message : String(err)
			)
			return null
		}
	}

	/**
	 * Delete a snapshot.
	 */
	delete(sessionId: string): void {
		const path = this.#snapshotPath(sessionId)
		if (existsSync(path)) {
			unlinkSync(path)
		}
	}

	/**
	 * Check if a snapshot exists.
	 */
	has(sessionId: string): boolean {
		return existsSync(this.#snapshotPath(sessionId))
	}

	// ── Private ──────────────────────────────────────────────────────────

	#snapshotPath(sessionId: string): string {
		// Sanitize sessionId for filesystem use
		const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
		return join(this.#dir, `${safe}.json`)
	}
}
