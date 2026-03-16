/**
 * Generic workspace file I/O — read, write, list files
 * in a workspace directory. No agent-specific content.
 */

import { join } from 'node:path'
import {
	writeFileSync,
	readFileSync,
	readdirSync
} from 'node:fs'

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
 * List all markdown files in the workspace directory.
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
