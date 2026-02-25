import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import {
	agentMessageSchema,
	agentEventSchema
} from '../src/schemas'
import type {
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	AgentEvent
} from '../src/types'

// ============================================================================
// Message round-trip tests
// ============================================================================

describe('agentMessageSchema', () => {
	test('round-trips UserMessage with text', () => {
		const msg: UserMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips UserMessage with image', () => {
		const msg: UserMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'Look' },
				{
					type: 'image',
					data: 'base64data',
					mimeType: 'image/png'
				}
			],
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips AssistantMessage with text only', () => {
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
					input: 0.01,
					output: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.03
				}
			},
			stopReason: 'stop',
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips AssistantMessage with thinking + tool calls', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'Let me think...' },
				{ type: 'text', text: "I'll check the weather" },
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

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips AssistantMessage with errorMessage', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: '' }],
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'error',
			errorMessage: 'Rate limit exceeded',
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips ToolResultMessage', () => {
		const msg: ToolResultMessage = {
			role: 'toolResult',
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			content: [{ type: 'text', text: 'Sunny, 72F' }],
			isError: false,
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('round-trips ToolResultMessage with error', () => {
		const msg: ToolResultMessage = {
			role: 'toolResult',
			toolCallId: 'tc_2',
			toolName: 'search',
			content: [
				{ type: 'text', text: 'Connection refused' }
			],
			isError: true,
			timestamp: 1000
		}

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})

	test('rejects invalid role', () => {
		expect(() =>
			v.parse(agentMessageSchema, {
				role: 'invalid',
				content: [],
				timestamp: 0
			})
		).toThrow()
	})

	test('round-trips AssistantMessage with empty content', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: [],
			provider: 'openai',
			model: 'gpt-4o',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
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

		const json = JSON.parse(JSON.stringify(msg))
		const parsed = v.parse(agentMessageSchema, json)

		expect(parsed).toEqual(msg)
	})
})

// ============================================================================
// Agent event round-trip tests
// ============================================================================

describe('agentEventSchema', () => {
	test('round-trips agent_start', () => {
		const event: AgentEvent = { type: 'agent_start' }
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips agent_end', () => {
		const event: AgentEvent = {
			type: 'agent_end',
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'Hi' }],
					timestamp: 1000
				}
			]
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips message_start', () => {
		const event: AgentEvent = {
			type: 'message_start',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: '' }],
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
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
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips message_update with text_delta', () => {
		const event: AgentEvent = {
			type: 'message_update',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Hello' }],
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
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
			},
			streamEvent: {
				type: 'text_delta',
				contentIndex: 0,
				delta: 'Hello'
			}
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips tool_execution_start', () => {
		const event: AgentEvent = {
			type: 'tool_execution_start',
			toolCallId: 'tc_1',
			toolName: 'search',
			args: { query: 'test' }
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips tool_execution_end', () => {
		const event: AgentEvent = {
			type: 'tool_execution_end',
			toolCallId: 'tc_1',
			toolName: 'search',
			result: {
				content: [
					{ type: 'text', text: 'Found 3 results' }
				],
				details: { count: 3 }
			},
			isError: false
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('round-trips turn_end with tool results', () => {
		const event: AgentEvent = {
			type: 'turn_end',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Done' },
					{
						type: 'toolCall',
						id: 'tc_1',
						name: 'search',
						arguments: { q: 'test' }
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
			},
			toolResults: [
				{
					role: 'toolResult',
					toolCallId: 'tc_1',
					toolName: 'search',
					content: [{ type: 'text', text: 'results' }],
					isError: false,
					timestamp: 1001
				}
			]
		}
		const parsed = v.parse(
			agentEventSchema,
			JSON.parse(JSON.stringify(event))
		)
		expect(parsed).toEqual(event)
	})

	test('rejects invalid event type', () => {
		expect(() =>
			v.parse(agentEventSchema, { type: 'invalid_event' })
		).toThrow()
	})
})
