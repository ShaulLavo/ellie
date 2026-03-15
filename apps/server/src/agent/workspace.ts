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
	readdirSync,
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

/**
 * Write content to a workspace file. Creates the file if it doesn't exist.
 */
export function writeWorkspaceFile(
	workspaceDir: string,
	filename: string,
	content: string
): void {
	const filePath = join(workspaceDir, filename)
	writeFileSync(filePath, content, 'utf-8')
}

/**
 * List all files in the workspace directory.
 */
export function listWorkspaceFiles(
	workspaceDir: string
): string[] {
	try {
		return readdirSync(workspaceDir).filter(f =>
			f.endsWith('.md')
		)
	} catch {
		return []
	}
}
