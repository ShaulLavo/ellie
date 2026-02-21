import type { PartialProcedureHandlers } from "@ellie/rpc/server"
import type { AppRouter } from "@ellie/router"
import type { AgentManager } from "../agent/manager"

type AgentActionInput = { message?: unknown } | undefined

function readMessage(input: unknown): string {
	const body = input as AgentActionInput
	if (typeof body?.message !== "string" || body.message.length === 0) {
		throw new Error("Missing 'message' field in request body")
	}
	return body.message
}

export function createAgentProcedureHandlers(
	manager: AgentManager,
): PartialProcedureHandlers<AppRouter> {
	return {
		agentPrompt: async (input, params) => {
			const message = readMessage(input)
			const { runId } = await manager.prompt(params.chatId, message)
			return { runId, chatId: params.chatId, status: "started" as const }
		},

		agentSteer: async (input, params) => {
			const message = readMessage(input)
			manager.steer(params.chatId, message)
			return { status: "queued" as const }
		},

		agentAbort: async (_input, params) => {
			manager.abort(params.chatId)
			return { status: "aborted" as const }
		},

		agentHistory: async (_input, params) => {
			return { messages: manager.loadHistory(params.chatId) }
		},
	}
}
