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
			'async function no_args_tool(args: {} = {} as any)'
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

	test('escapes */ in description to prevent JSDoc injection', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'injected',
				description: 'ok */ console.log("INJECT") /*',
				inputSchema: { type: 'object' }
			}
		]

		const sdk = await generateSDK(tools)

		// The literal */ should be escaped so it doesn't close the JSDoc
		expect(sdk).not.toContain('*/ console.log')
		expect(sdk).toContain('*\\/ console.log')
		// The wrapper function should still be generated
		expect(sdk).toContain('async function injected')
	})

	test('escapes */ in schema JSON to prevent JSDoc injection', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'schema_inject',
				description: 'safe',
				inputSchema: {
					type: 'object',
					description: 'has */ in it'
				}
			}
		]

		const sdk = await generateSDK(tools)

		expect(sdk).not.toContain('"has */ in it"')
		expect(sdk).toContain('*\\/')
	})

	test('generates safe variable for non-identifier tool names', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'send-email',
				description: 'Send an email',
				inputSchema: {
					type: 'object',
					properties: { to: { type: 'string' } },
					required: ['to']
				}
			}
		]

		const sdk = await generateSDK(tools)

		// Should not use "function send-email" (invalid TS)
		expect(sdk).not.toContain('function send-email')
		// Should generate a safe const variable
		expect(sdk).toContain('__tool_send_email')
		// Should still pass the real name to __callTool
		expect(sdk).toContain('"send-email"')
	})

	test('quotes non-identifier property keys in type literal', async () => {
		const tools: ToolDefinition[] = [
			{
				name: 'test_tool',
				description: 'Tool with hyphenated keys',
				inputSchema: {
					type: 'object',
					properties: {
						'user-id': { type: 'string' },
						normal: { type: 'string' }
					},
					required: ['user-id']
				}
			}
		]

		const sdk = await generateSDK(tools)

		// Hyphenated key should be quoted in the type literal
		expect(sdk).toContain('"user-id": string')
		// Normal key should not be quoted in the type literal
		expect(sdk).toContain('\tnormal?: string')
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
