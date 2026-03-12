/**
 * Workspace tools — read and write workspace files.
 *
 * These are the agent's first real tools. They let it read and update
 * its own workspace files (IDENTITY.md, SOUL.md, MEMORY.md, etc.).
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import {
	readWorkspaceFile,
	writeWorkspaceFile,
	listWorkspaceFiles
} from '../workspace'

// ── Schemas ──────────────────────────────────────────────────────────────

const readParams = v.object({
	path: v.pipe(
		v.string(),
		v.description(
			'Filename to read (e.g. "IDENTITY.md", "SOUL.md", "MEMORY.md")'
		)
	)
})

const writeParams = v.object({
	path: v.pipe(
		v.string(),
		v.description(
			'Filename to write (e.g. "IDENTITY.md", "MEMORY.md")'
		)
	),
	content: v.pipe(
		v.string(),
		v.description('The full content to write to the file')
	)
})

type ReadParams = v.InferOutput<typeof readParams>
type WriteParams = v.InferOutput<typeof writeParams>

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create workspace tools bound to a specific workspace directory.
 */
export function createWorkspaceTools(
	workspaceDir: string
): AgentTool[] {
	return [
		createReadWorkspaceFileTool(workspaceDir),
		createWriteWorkspaceFileTool(workspaceDir)
	]
}

// ── read_workspace_file ──────────────────────────────────────────────────

function createReadWorkspaceFileTool(
	workspaceDir: string
): AgentTool {
	return {
		name: 'read_workspace_file',
		description:
			'Read a file from the workspace directory. Use this to read your memory files (IDENTITY.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md, etc.). Call with path set to the filename.',
		label: 'Reading workspace file',
		parameters: readParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as ReadParams
			const available = listWorkspaceFiles(workspaceDir)

			if (!available.includes(params.path)) {
				return {
					content: [
						{
							type: 'text',
							text: `File not found: ${params.path}\n\nAvailable files: ${available.join(', ')}`
						}
					],
					details: { path: params.path, found: false }
				}
			}

			const content = readWorkspaceFile(
				workspaceDir,
				params.path
			)

			if (content === undefined) {
				return {
					content: [
						{
							type: 'text',
							text: `Failed to read: ${params.path}`
						}
					],
					details: { path: params.path, found: false }
				}
			}

			return {
				content: [{ type: 'text', text: content }],
				details: {
					path: params.path,
					found: true,
					length: content.length
				}
			}
		}
	}
}

// ── write_workspace_file ─────────────────────────────────────────────────

function createWriteWorkspaceFileTool(
	workspaceDir: string
): AgentTool {
	return {
		name: 'write_workspace_file',
		description:
			'Write content to a workspace file. Use this to update your memory files (IDENTITY.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md, etc.). Overwrites the entire file.',
		label: 'Writing workspace file',
		parameters: writeParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as WriteParams

			// Safety: prevent path traversal
			if (params.path.includes('..')) {
				return {
					content: [
						{
							type: 'text',
							text: `Invalid path: ${params.path} — path traversal is not allowed.`
						}
					],
					details: { path: params.path, written: false }
				}
			}

			try {
				writeWorkspaceFile(
					workspaceDir,
					params.path,
					params.content
				)

				return {
					content: [
						{
							type: 'text',
							text: `Written ${params.content.length} chars to ${params.path}`
						}
					],
					details: {
						path: params.path,
						written: true,
						length: params.content.length
					}
				}
			} catch (err) {
				return {
					content: [
						{
							type: 'text',
							text: `Failed to write ${params.path}: ${err instanceof Error ? err.message : String(err)}`
						}
					],
					details: { path: params.path, written: false }
				}
			}
		}
	}
}
