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
import type { EventStore } from '@ellie/db'
import type { TraceRecorder, BlobSink } from '@ellie/trace'
import {
	createTracedToolWrapper,
	createTracedReplTool
} from '@ellie/trace'
import { createWorkspaceTools } from './workspace-tools'
import { createShellTool } from './shell-tool'
import { createRipgrepTool } from './ripgrep-tool'
import { createWebFetchTool } from './web-fetch/tool'
import { createWebSearchTool } from './web-search/tool'
import {
	createSessionExecTool,
	createExecTool
} from './session-exec'
import { createImageGenTool } from './image-gen/tool'

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolRegistryConfig {
	/** Workspace directory for file I/O tools. */
	workspaceDir: string
	/** Data directory for generated artifacts and image-gen tracing. */
	dataDir: string
	/** Returns the currently bound session ID (for REPL isolation). */
	getSessionId: () => string | null
	/** Returns the currently active run ID. */
	getRunId: () => string | null
	/** Trace recorder for wrapping tools with traced facades. */
	traceRecorder?: TraceRecorder
	/** Blob sink for traced overflow. */
	blobSink?: BlobSink
	/** Returns the active trace scope for the current run. Resolved lazily per-invocation. */
	getTraceScope?: () =>
		| import('@ellie/trace').TraceScope
		| undefined
	/** Event store for tool result caching (web fetch deduplication). */
	eventStore?: EventStore
	/** Path to .credentials.json for API key loading. */
	credentialsPath?: string
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
	// Raw tools — no trace wrapping (used inside REPL HTTP handler)
	const webSearch = createWebSearchTool(
		config.credentialsPath
	)
	const rawBasicTools: AgentTool[] = [
		...createWorkspaceTools(config.workspaceDir),
		createShellTool(config.workspaceDir),
		createRipgrepTool(config.workspaceDir),
		createWebFetchTool(config.eventStore),
		...(webSearch ? [webSearch] : [])
	]
	const rawDirectOnlyTools: AgentTool[] = config.blobSink
		? [
				createImageGenTool({
					blobSink: config.blobSink,
					dataDir: config.dataDir,
					getSessionId: config.getSessionId,
					getRunId: config.getRunId
				})
			]
		: []

	// Traced versions for direct agent-loop use
	let basicDirectTools: AgentTool[] = [
		...rawBasicTools,
		...rawDirectOnlyTools
	]
	if (config.traceRecorder && config.getTraceScope) {
		const traceOpts = {
			recorder: config.traceRecorder,
			blobSink: config.blobSink,
			getParentScope: config.getTraceScope
		}

		basicDirectTools = rawBasicTools.map(t =>
			createTracedToolWrapper(t, traceOpts)
		)
	}

	// Exec tools get RAW tools + trace deps (not traced wrappers —
	// the REPL HTTP handler does its own tracing to avoid double-tracing)
	const traceDeps = config.traceRecorder
		? {
				recorder: config.traceRecorder,
				blobSink: config.blobSink
			}
		: undefined

	let execTools: AgentTool[] = [
		createExecTool(rawBasicTools, traceDeps),
		createSessionExecTool(
			config.getSessionId,
			rawBasicTools,
			traceDeps
		)
	]

	// Wrap exec tools with traced REPL facades
	if (config.traceRecorder && config.getTraceScope) {
		const traceOpts = {
			recorder: config.traceRecorder,
			blobSink: config.blobSink,
			getParentScope: config.getTraceScope
		}

		execTools = execTools.map(t =>
			createTracedReplTool(t, traceOpts)
		)
	}

	return {
		basicDirectTools,
		execTools,
		all: [...basicDirectTools, ...execTools]
	}
}
