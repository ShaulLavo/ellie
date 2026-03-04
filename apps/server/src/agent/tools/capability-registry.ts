/**
 * Capability registry — assembles the exec-mode tool surface.
 *
 * Organizes tools into three tiers:
 *   1. basicDirectTools  — trivial single-call tools (shell, search, file I/O).
 *   2. scriptExecTools    — bounded ephemeral script execution (script_exec).
 *   3. sessionExecTools   — persistent session execution (session_exec).
 *
 * The controller composes these into the final model-visible tool set:
 *   basicDirectTools + scriptExecTools + sessionExecTools
 */

import type { AgentTool } from '@ellie/agent'
import { createWorkspaceTools } from './workspace-tools'
import { createShellTool } from './shell-tool'
import { createRipgrepTool } from './ripgrep-tool'
import { createScriptExecTool } from './script-exec'
import { createSessionExecTool } from './session-exec'

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
	/** Ephemeral script execution tool (script_exec). */
	scriptExecTools: AgentTool[]
	/** Persistent session execution tool (session_exec). */
	sessionExecTools: AgentTool[]
	/** All tools combined for model registration. */
	all: AgentTool[]
}

// ── Registry factory ────────────────────────────────────────────────────

/**
 * Build the complete tool registry for exec-mode architecture.
 *
 * Tool composition:
 *   - script_exec receives basicDirectTools as its sandbox tools
 *     (it can call them as async functions inside the sandbox).
 *   - session_exec receives basicDirectTools as IPC-bridged tools
 *     (same tool access as script_exec, but state persists).
 *   - Neither exec tool includes itself, preventing recursion.
 */
export function createToolRegistry(
	config: ToolRegistryConfig
): ToolRegistry {
	const basicDirectTools: AgentTool[] = [
		...createWorkspaceTools(config.workspaceDir),
		createShellTool(config.workspaceDir),
		createRipgrepTool(config.workspaceDir)
	]

	const scriptExecTools: AgentTool[] = [
		createScriptExecTool(basicDirectTools)
	]

	const sessionExecTools: AgentTool[] = [
		createSessionExecTool(
			config.dataDir,
			config.getSessionId,
			basicDirectTools
		)
	]

	return {
		basicDirectTools,
		scriptExecTools,
		sessionExecTools,
		all: [
			...basicDirectTools,
			...scriptExecTools,
			...sessionExecTools
		]
	}
}
