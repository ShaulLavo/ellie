import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	ToolResultMessage
} from '../types'

export type EmitFn = (event: AgentEvent) => void

export interface ProcessResult {
	messages: AgentMessage[]
	toolResults: ToolResultMessage[]
	lastAssistant: AssistantMessage
	abortedOrError: boolean
}

export interface GuardrailState {
	startedAtMs: number
	modelCallCount: number
	costUsd: number
	limitTriggered: boolean
}
