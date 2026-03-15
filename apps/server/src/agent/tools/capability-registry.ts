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
import { createSessionExecTool } from './session-exec/session-exec-tool'
import { createExecTool } from './session-exec/exec-tool'
import { createImageGenTool } from './image-gen/tool'
import { createBrowseVoiceCatalogTool } from './voice/browse-catalog'
import { createSetDefaultVoiceTool } from './voice/set-default-voice'

interface ToolRegistryConfig {
	workspaceDir: string
	dataDir: string
	getBranchId: () => string | null
	getRunId: () => string | null
	traceRecorder?: TraceRecorder
	blobSink?: BlobSink
	getTraceScope?: () =>
		| import('@ellie/trace').TraceScope
		| undefined
	eventStore?: EventStore
	credentialsPath?: string
}

export interface ToolRegistry {
	basicDirectTools: AgentTool[]
	execTools: AgentTool[]
	all: AgentTool[]
}

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
	const voiceCatalog = createBrowseVoiceCatalogTool(
		config.credentialsPath
	)
	const rawDirectOnlyTools: AgentTool[] = [
		...(config.blobSink
			? [
					createImageGenTool({
						blobSink: config.blobSink,
						dataDir: config.dataDir,
						getBranchId: config.getBranchId,
						getRunId: config.getRunId,
						credentialsPath: config.credentialsPath
					})
				]
			: []),
		createSetDefaultVoiceTool(config.dataDir),
		...(voiceCatalog ? [voiceCatalog] : [])
	]

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

		basicDirectTools = [
			...rawBasicTools,
			...rawDirectOnlyTools
		].map(t => createTracedToolWrapper(t, traceOpts))
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
			config.getBranchId,
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
