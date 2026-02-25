import { describe, expect, test } from 'bun:test'
import {
	toModelMessage,
	toModelMessages
} from '../src/messages'
import type {
	UserMessage,
	AssistantMessage,
	ToolResultMessage
} from '../src/types'

describe('toModelMessage', () => {
	test('converts UserMessage with text', () => {
		const msg: UserMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.role).toBe('user')
		expect(result.content).toEqual([
			{ type: 'text', content: 'Hello' }
		])
	})

	test('converts UserMessage with image', () => {
		const msg: UserMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'Look at this' },
				{
					type: 'image',
					data: 'base64data',
					mimeType: 'image/png'
				}
			],
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.role).toBe('user')
		expect(result.content).toEqual([
			{ type: 'text', content: 'Look at this' },
			{
				type: 'image',
				source: {
					type: 'data',
					value: 'base64data',
					mimeType: 'image/png'
				}
			}
		])
	})

	test('converts AssistantMessage with text only', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'Hi there' }],
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'stop',
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.role).toBe('assistant')
		expect(result.content).toBe('Hi there')
		expect(result.toolCalls).toBeUndefined()
	})

	test('converts AssistantMessage with tool calls', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Let me check' },
				{
					type: 'toolCall',
					id: 'tc_1',
					name: 'get_weather',
					arguments: { city: 'NYC' }
				}
			],
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'toolUse',
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.role).toBe('assistant')
		expect(result.content).toBe('Let me check')
		expect(result.toolCalls).toEqual([
			{
				id: 'tc_1',
				type: 'function',
				function: {
					name: 'get_weather',
					arguments: '{"city":"NYC"}'
				}
			}
		])
	})

	test('strips thinking content from AssistantMessage', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [
				{
					type: 'thinking',
					thinking: 'Let me think about this...'
				},
				{ type: 'text', text: 'The answer is 42' }
			],
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'stop',
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.content).toBe('The answer is 42')
	})

	test('converts AssistantMessage with empty text to null', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'tc_1',
					name: 'search',
					arguments: { q: 'test' }
				}
			],
			provider: 'openai',
			model: 'gpt-4o',
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'toolUse',
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.content).toBeNull()
	})

	test('converts ToolResultMessage', () => {
		const msg: ToolResultMessage = {
			role: 'toolResult',
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			content: [{ type: 'text', text: 'Sunny, 72°F' }],
			isError: false,
			timestamp: 1000
		}

		const result = toModelMessage(msg)

		expect(result.role).toBe('tool')
		expect(result.content).toBe('Sunny, 72°F')
		expect(result.toolCallId).toBe('tc_1')
	})
})

describe('toModelMessages', () => {
	test('converts array of messages', () => {
		const msgs = [
			{
				role: 'user' as const,
				content: [{ type: 'text' as const, text: 'Hi' }],
				timestamp: 1000
			},
			{
				role: 'assistant' as const,
				content: [
					{ type: 'text' as const, text: 'Hello!' }
				],
				provider: 'anthropic' as const,
				model: 'claude-sonnet-4-6',
				usage: {
					input: 5,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 8,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: 'stop' as const,
				timestamp: 1001
			}
		]

		const results = toModelMessages(msgs)

		expect(results.length).toBe(2)
		expect(results[0].role).toBe('user')
		expect(results[1].role).toBe('assistant')
	})
})
