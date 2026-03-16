// Assistant agent definition
export {
	createAssistantAgentDefinition,
	type AssistantAgentConfig,
	type AssistantAgentState
} from './definition'

// Workspace seeding (I/O re-exported from @ellie/agent/workspace)
export { seedWorkspace } from './workspace'
export {
	readWorkspaceFile,
	writeWorkspaceFile,
	listWorkspaceFiles
} from '@ellie/agent/workspace'

// System prompt
export { buildSystemPrompt } from './system-prompt'

// Memory
export { MemoryOrchestrator } from './memory-orchestrator'

// Tools
export {
	createToolRegistry,
	type ToolRegistry
} from './tools/capability-registry'
