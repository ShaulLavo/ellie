/**
 * Prompt — composes a prompt bundle (system prompt + messages)
 * for the Agent runtime.
 *
 * The system prompt is built from workspace files.
 * Messages are loaded from the session's conversation history.
 */

import type { AgentMessage } from '@ellie/agent'
import type { EventStore } from '@ellie/db'
import { buildSystemPrompt } from './system-prompt'

export interface PromptBundle {
	systemPrompt: string
	messages: AgentMessage[]
}

/**
 * Build a prompt bundle for a given session.
 * Reads workspace files for system prompt and loads history from DB.
 */
export function buildPromptBundle(
	workspaceDir: string,
	eventStore: EventStore,
	sessionId: string
): PromptBundle {
	const systemPrompt = buildSystemPrompt(workspaceDir)
	const messages = eventStore.getConversationHistory(
		sessionId
	) as AgentMessage[]

	return { systemPrompt, messages }
}
