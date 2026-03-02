import { describe, expect, test } from 'bun:test'
import { generateSDK } from '../src/sdk-generator'
import type { ToolDefinition } from '../src/types'

describe('generateSDK', () => {
	test('generates wrapper for a tool with required and optional args', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'read_file',
				description: 'Read a file from disk',
				inputSchema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'File path'
						},
						encoding: {
							type: 'string',
							description: 'Encoding'
						}
					},
					required: ['path']
				}
			}
		]

		const sdk = await generateSDK(tools)

		// Has the infrastructure
		expect(sdk).toContain('const __pending = new Map')
		expect(sdk).toContain('async function __callTool')
		expect(sdk).toContain('Bun.stdin.stream().getReader()')

		// Has the tool wrapper
		expect(sdk).toContain(
			'async function read_file(args: {'
		)
		expect(sdk).toContain('path: string')
		expect(sdk).toContain('encoding?: string')
		expect(sdk).toContain('return __callTool("read_file"')
	})

	test('generates wrappers for multiple tools', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'tool_a',
				description: 'First tool',
				inputSchema: {
					type: 'object',
					properties: { x: { type: 'number' } },
					required: ['x']
				}
			},
			{
				name: 'tool_b',
				description: 'Second tool',
				inputSchema: {
					type: 'object',
					properties: { y: { type: 'boolean' } },
					required: ['y']
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain('async function tool_a')
		expect(sdk).toContain('async function tool_b')
		expect(sdk).toContain('x: number')
		expect(sdk).toContain('y: boolean')
	})

	test('includes JSDoc with description and schema', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'search',
				description: 'Search for items by query',
				inputSchema: {
					type: 'object',
					properties: { query: { type: 'string' } },
					required: ['query']
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain('/**')
		expect(sdk).toContain('* Search for items by query')
		expect(sdk).toContain('* Input schema:')
	})

	test('handles empty/missing schema properties gracefully', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'no_args_tool',
				description: 'Tool with no arguments',
				inputSchema: { type: 'object' }
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain(
			'async function no_args_tool(args: {})'
		)
	})

	test('handles array type in schema', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'list_tool',
				description: 'Tool with array arg',
				inputSchema: {
					type: 'object',
					properties: {
						items: {
							type: 'array',
							items: { type: 'string' }
						}
					},
					required: ['items']
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain('items: string[]')
	})

	test('falls back to unknown for unrecognized types', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'exotic_tool',
				description: 'Tool with exotic type',
				inputSchema: {
					type: 'object',
					properties: {
						data: { type: 'null' as string }
					},
					required: ['data']
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain('data: unknown')
	})

	test('maps integer type to number', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'int_tool',
				description: 'Tool with integer arg',
				inputSchema: {
					type: 'object',
					properties: {
						count: { type: 'integer' }
					},
					required: ['count']
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).toContain('count: number')
	})
})
