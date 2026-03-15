import type { AgentMessage } from '@ellie/agent'
import type { EventStore } from '@ellie/db'
import { buildSystemPrompt } from './system-prompt'

export interface PromptBundle {
	systemPrompt: string
	messages: AgentMessage[]
}

export function buildPromptBundle(
	workspaceDir: string,
	eventStore: EventStore,
	branchId: string
): PromptBundle {
	const { prompt: systemPrompt } =
		buildSystemPrompt(workspaceDir)
	const messages = eventStore.getConversationHistory(
		branchId
	) as AgentMessage[]

	return { systemPrompt, messages }
}
