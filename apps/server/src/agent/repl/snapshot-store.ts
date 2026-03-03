/**
 * Snapshot store — persist and restore REPL session state.
 *
 * Snapshots are keyed by (sessionId, workspaceDir, gitHead) so
 * that state is only restored when the execution context is
 * compatible.
 */

import {
	mkdir,
	readFile,
	writeFile,
	rename,
	unlink,
	access
} from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'

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

// ── Helpers ─────────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
	return (
		err !== null &&
		typeof err === 'object' &&
		(err as NodeJS.ErrnoException).code === 'ENOENT'
	)
}

// ── Snapshot Store ──────────────────────────────────────────────────────

export class SnapshotStore {
	readonly #dir: string
	#ready: Promise<void>

	constructor(dataDir: string) {
		this.#dir = join(dataDir, 'repl-snapshots')
		this.#ready = mkdir(this.#dir, {
			recursive: true
		}).then(() => {})
	}

	/**
	 * Save a snapshot of REPL state (atomic write via temp + rename).
	 */
	async save(
		sessionId: string,
		workspaceDir: string,
		gitHead: string | null,
		globals: Record<string, unknown>
	): Promise<SnapshotMetadata> {
		await this.#ready

		const metadata: SnapshotMetadata = {
			sessionId,
			workspaceDir,
			gitHead,
			savedAt: Date.now(),
			version: SNAPSHOT_VERSION
		}

		const snapshot: Snapshot = { metadata, globals }
		const path = this.#snapshotPath(sessionId)
		const tmpPath = `${path}.tmp-${process.pid}`

		try {
			await writeFile(
				tmpPath,
				JSON.stringify(snapshot),
				'utf-8'
			)
			await rename(tmpPath, path)
		} catch (err) {
			// Clean up temp file on failure
			try {
				await unlink(tmpPath)
			} catch {
				// Best-effort cleanup
			}
			throw err
		}

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
	async restore(
		sessionId: string,
		workspaceDir: string,
		gitHead: string | null
	): Promise<Snapshot | null> {
		await this.#ready
		const path = this.#snapshotPath(sessionId)

		let raw: string
		try {
			raw = await readFile(path, 'utf-8')
		} catch (err) {
			if (isEnoent(err)) return null
			throw err
		}

		try {
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
				`[snapshot-store] failed to parse snapshot for session=${sessionId}:`,
				err instanceof Error ? err.message : String(err)
			)
			return null
		}
	}

	/**
	 * Delete a snapshot. Ignores missing files, propagates other errors.
	 */
	async delete(sessionId: string): Promise<void> {
		await this.#ready
		const path = this.#snapshotPath(sessionId)
		try {
			await unlink(path)
		} catch (err) {
			if (!isEnoent(err)) throw err
		}
	}

	/**
	 * Check if a snapshot exists. Propagates non-ENOENT errors.
	 */
	async has(sessionId: string): Promise<boolean> {
		await this.#ready
		try {
			await access(this.#snapshotPath(sessionId))
			return true
		} catch (err) {
			if (isEnoent(err)) return false
			throw err
		}
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Derive a collision-safe filename from sessionId.
	 *
	 * Uses a sanitized prefix for human readability plus a SHA-256
	 * digest of the full sessionId to prevent collisions from lossy
	 * character replacement.
	 */
	#snapshotPath(sessionId: string): string {
		const prefix = sessionId
			.replace(/[^a-zA-Z0-9_-]/g, '_')
			.slice(0, 32)
		const digest = createHash('sha256')
			.update(sessionId)
			.digest('hex')
			.slice(0, 12)
		return join(this.#dir, `${prefix}-${digest}.json`)
	}
}
