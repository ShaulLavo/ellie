/**
 * Workspace — seeds template files into the global workspace directory.
 *
 * Uses `wx` semantics (write-if-missing): existing files are never overwritten,
 * so user edits are preserved across restarts.
 *
 * Generic workspace I/O (read/write/list) lives in @ellie/agent/workspace.
 */

import { join } from 'node:path'
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync
} from 'node:fs'

const TEMPLATES_DIR =
	process.env.ELLIE_WORKSPACE_TEMPLATES_DIR ??
	join(import.meta.dir, 'templates')

function isEexistError(err: unknown): boolean {
	return (
		err instanceof Error &&
		'code' in err &&
		(err as NodeJS.ErrnoException).code === 'EEXIST'
	)
}

const TEMPLATE_FILES = [
	'AGENTS.md',
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'TOOLS.md',
	'HEARTBEAT.md',
	'BOOTSTRAP.md'
] as const

/**
 * Seed template files into workspace directory.
 * Only writes files that don't already exist (atomic no-clobber).
 * Returns the workspace path.
 */
export function seedWorkspace(dataDir: string): string {
	const workspaceDir = join(dataDir, 'workspace')
	mkdirSync(workspaceDir, { recursive: true })

	for (const filename of TEMPLATE_FILES) {
		const dest = join(workspaceDir, filename)
		if (existsSync(dest)) continue

		const src = join(TEMPLATES_DIR, filename)
		try {
			const content = readFileSync(src, 'utf-8')
			// Use wx flag: fail if file already exists (race-safe)
			writeFileSync(dest, content, { flag: 'wx' })
		} catch (err) {
			if (isEexistError(err)) continue
			console.error(
				`[workspace] failed to seed ${filename}:`,
				err instanceof Error ? err.message : String(err)
			)
		}
	}

	return workspaceDir
}
