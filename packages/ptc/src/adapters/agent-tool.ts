import type { AgentTool } from '@ellie/agent'
import { ulid } from 'fast-ulid'
import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'
import { executePTC } from '../ptc-host'
import type {
	ExecutePTCOptions,
	JsonSchema,
	ToolClient,
	ToolDefinition,
	ToolResult
} from '../types'

/**
 * Convert an AgentTool[] into generic ToolDefinition[] + ToolClient
 * so they can be used with `executePTC`.
 */
export function createAgentToolBridge(
	agentTools: AgentTool[]
): {
	tools: ToolDefinition[]
	client: ToolClient
} {
	// Detect duplicate tool names early
	const seen = new Set<string>()
	for (const t of agentTools) {
		if (seen.has(t.name)) {
			throw new Error(`Duplicate tool name: ${t.name}`)
		}
		seen.add(t.name)
	}

	const toolMap = new Map<string, AgentTool>(
		agentTools.map(t => [t.name, t])
	)

	const tools: ToolDefinition[] = agentTools.map(t => ({
		name: t.name,
		description: t.description,
		inputSchema: toJsonSchema(t.parameters) as JsonSchema
	}))

	const client: ToolClient = {
		async callTool(
			name: string,
			args: Record<string, unknown>
		): Promise<ToolResult> {
			const tool = toolMap.get(name)
			if (!tool) {
				throw new Error(`Unknown tool: ${name}`)
			}

			// Validate args against the Valibot schema
			const parsed = v.parse(tool.parameters, args)

			// Execute tool – we generate a synthetic call ID
			const callId = `ptc-${ulid()}`
			const result = await tool.execute(callId, parsed)

			return result as unknown as ToolResult
		}
	}

	return { tools, client }
}

/**
 * Convenience: run agent code with AgentTool[] directly, handling
 * the bridge internally.
 */
export async function executePTCFromAgentTools(
	agentCode: string,
	agentTools: AgentTool[],
	options?: ExecutePTCOptions
): Promise<string> {
	const { tools, client } =
		createAgentToolBridge(agentTools)
	return executePTC(agentCode, tools, client, options)
}
