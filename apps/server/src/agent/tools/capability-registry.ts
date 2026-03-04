/**
 * Capability registry — assembles the tool surface.
 *
 * Organizes tools into three tiers:
 *   1. basicDirectTools — trivial single-call tools (shell, search, file I/O).
 *   2. execTools         — one-shot isolated execution (exec) + persistent REPL (session_exec).
 *
 * The controller composes these into the final model-visible tool set:
 *   basicDirectTools + execTools
 */

import type { AgentTool } from '@ellie/agent'
import { createWorkspaceTools } from './workspace-tools'
import { createShellTool } from './shell-tool'
import { createRipgrepTool } from './ripgrep-tool'
import { createWebFetchTool } from './web-fetch-tool'
import {
	createSessionExecTool,
	createExecTool
} from './session-exec'

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolRegistryConfig {
	/** Workspace directory for file I/O tools. */
	workspaceDir: string
	/** Data directory for session artifacts and snapshots. */
	dataDir: string
	/** Returns the currently bound session ID (for REPL isolation). */
	getSessionId: () => string | null
}

export interface ToolRegistry {
	/** Simple direct tools — shell, search, workspace read/write. */
	basicDirectTools: AgentTool[]
	/** Code execution tools (exec + session_exec). */
	execTools: AgentTool[]
	/** All tools combined for model registration. */
	all: AgentTool[]
}

// ── Registry factory ────────────────────────────────────────────────────

/**
 * Build the complete tool registry.
 *
 * Tool composition:
 *   - exec and session_exec receive basicDirectTools so they are
 *     available as async functions inside the REPL subprocess.
 *   - Neither exec tool includes itself, preventing recursion.
 */
export function createToolRegistry(
	config: ToolRegistryConfig
): ToolRegistry {
	const basicDirectTools: AgentTool[] = [
		...createWorkspaceTools(config.workspaceDir),
		createShellTool(config.workspaceDir),
		createRipgrepTool(config.workspaceDir),
		createWebFetchTool()
	]

	const execTools: AgentTool[] = [
		createExecTool(basicDirectTools),
		createSessionExecTool(
			config.dataDir,
			config.getSessionId,
			basicDirectTools
		)
	]

	return {
		basicDirectTools,
		execTools,
		all: [...basicDirectTools, ...execTools]
	}
}
