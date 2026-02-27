/**
 * Workspace — seeds template files into the global workspace directory.
 *
 * Uses `wx` semantics (write-if-missing): existing files are never overwritten,
 * so user edits are preserved across restarts.
 */

import { join } from 'node:path'
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync
} from 'node:fs'

const TEMPLATES_DIR = join(import.meta.dir, 'templates')

const TEMPLATE_FILES = [
	'AGENTS.md',
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'TOOLS.md',
	'MEMORY.md',
	'HEARTBEAT.md',
	'BOOTSTRAP.md'
] as const

export type TemplateFile = (typeof TEMPLATE_FILES)[number]

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
			console.log(`[workspace] seeded ${filename}`)
		} catch (err) {
			if (
				err instanceof Error &&
				'code' in err &&
				(err as NodeJS.ErrnoException).code === 'EEXIST'
			) {
				continue // Another process created it — fine
			}
			console.error(
				`[workspace] failed to seed ${filename}:`,
				err instanceof Error ? err.message : String(err)
			)
		}
	}

	return workspaceDir
}

/**
 * Read a workspace file's content. Returns undefined if not found.
 */
export function readWorkspaceFile(
	workspaceDir: string,
	filename: string
): string | undefined {
	const filePath = join(workspaceDir, filename)
	try {
		return readFileSync(filePath, 'utf-8')
	} catch {
		return undefined
	}
}
