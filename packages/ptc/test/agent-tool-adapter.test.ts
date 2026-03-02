import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { createAgentToolBridge } from '../src/adapters/agent-tool'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'

// ── Helpers ─────────────────────────────────────────────────────────

function makeAgentTool(
	overrides?: Partial<AgentTool>
): AgentTool {
	return {
		name: 'greet',
		description: 'Greet someone',
		label: 'Greeting',
		parameters: v.object({
			name: v.string()
		}),
		execute: async (
			_callId: string,
			params: { name: string }
		): Promise<AgentToolResult> => ({
			content: [
				{ type: 'text', text: `Hello, ${params.name}!` }
			],
			details: { greeted: params.name }
		}),
		...overrides
	}
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createAgentToolBridge', () => {
	test('converts tool definitions with correct name/description/schema', () => {
		const tool = makeAgentTool()
		const { tools } = createAgentToolBridge([tool])

		expect(tools).toHaveLength(1)
		expect(tools[0].name).toBe('greet')
		expect(tools[0].description).toBe('Greet someone')
		expect(tools[0].inputSchema).toBeDefined()
		expect(tools[0].inputSchema.type).toBe('object')
		expect(tools[0].inputSchema.properties).toBeDefined()
		expect(
			tools[0].inputSchema.properties!.name
		).toBeDefined()
	})

	test('JSON schema has required fields', () => {
		const tool = makeAgentTool()
		const { tools } = createAgentToolBridge([tool])

		expect(tools[0].inputSchema.required).toContain('name')
	})

	test('callTool resolves for known tool', async () => {
		const tool = makeAgentTool()
		const { client } = createAgentToolBridge([tool])

		const result = await client.callTool('greet', {
			name: 'Alice'
		})

		expect(result).toBeDefined()
		const typed = result as AgentToolResult
		expect(typed.content).toHaveLength(1)
		expect(typed.content[0].type).toBe('text')
		expect(
			(typed.content[0] as { type: 'text'; text: string })
				.text
		).toBe('Hello, Alice!')
		expect(typed.details).toEqual({ greeted: 'Alice' })
	})

	test('callTool throws for unknown tool', async () => {
		const { client } = createAgentToolBridge([
			makeAgentTool()
		])

		await expect(
			client.callTool('nonexistent', { foo: 'bar' })
		).rejects.toThrow('Unknown tool: nonexistent')
	})

	test('callTool validates args via valibot', async () => {
		const tool = makeAgentTool()
		const { client } = createAgentToolBridge([tool])

		// Pass wrong type: name should be string, not number
		await expect(
			client.callTool('greet', { name: 42 })
		).rejects.toThrow()
	})

	test('result passthrough preserves content and details shape', async () => {
		const tool = makeAgentTool({
			execute: async (): Promise<AgentToolResult> => ({
				content: [
					{ type: 'text', text: 'line1' },
					{ type: 'text', text: 'line2' }
				],
				details: { multi: true, count: 2 }
			})
		})
		const { client } = createAgentToolBridge([tool])

		const result = (await client.callTool('greet', {
			name: 'Test'
		})) as AgentToolResult
		expect(result.content).toHaveLength(2)
		expect(result.details).toEqual({
			multi: true,
			count: 2
		})
	})

	test('handles tool with optional parameters', () => {
		const tool = makeAgentTool({
			parameters: v.object({
				name: v.string(),
				greeting: v.optional(v.string())
			})
		})
		const { tools } = createAgentToolBridge([tool])

		expect(tools[0].inputSchema.properties).toBeDefined()
		expect(
			tools[0].inputSchema.properties!.name
		).toBeDefined()
		expect(
			tools[0].inputSchema.properties!.greeting
		).toBeDefined()
		// "name" is required, "greeting" is optional
		expect(tools[0].inputSchema.required).toContain('name')
		expect(tools[0].inputSchema.required).not.toContain(
			'greeting'
		)
	})

	test('throws on duplicate tool names', () => {
		const tool1 = makeAgentTool({ name: 'dup' })
		const tool2 = makeAgentTool({ name: 'dup' })

		expect(() =>
			createAgentToolBridge([tool1, tool2])
		).toThrow('Duplicate tool name: dup')
	})
})
