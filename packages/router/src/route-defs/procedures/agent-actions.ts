import {
	agentAbortInputSchema,
	agentAbortOutputSchema,
	agentHistoryInputSchema,
	agentHistoryOutputSchema,
	agentPromptInputSchema,
	agentPromptOutputSchema,
	agentSteerInputSchema,
	agentSteerOutputSchema,
} from "@ellie/schemas/agent"
import { defineProcedures } from "../types"

export const agentActionProcedureDefs = defineProcedures({
	agentPrompt: {
		method: `POST`,
		path: `/agent/:chatId/prompt`,
		input: agentPromptInputSchema,
		output: agentPromptOutputSchema,
	},
	agentSteer: {
		method: `POST`,
		path: `/agent/:chatId/steer`,
		input: agentSteerInputSchema,
		output: agentSteerOutputSchema,
	},
	agentAbort: {
		method: `POST`,
		path: `/agent/:chatId/abort`,
		input: agentAbortInputSchema,
		output: agentAbortOutputSchema,
	},
	agentHistory: {
		method: `GET`,
		path: `/agent/:chatId/history`,
		input: agentHistoryInputSchema,
		output: agentHistoryOutputSchema,
	},
} as const)
