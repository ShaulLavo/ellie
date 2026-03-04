import { describe, expect, test } from 'bun:test'
import { agentLoop, agentLoopContinue } from '../src/loop'
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
	AssistantMessage
} from '../src/types'
import type {
	StreamChunk,
	AnyTextAdapter
} from '@tanstack/ai'
import * as v from 'valibot'

// ============================================================================
// Test helpers
// ============================================================================

/** Create a mock StreamFn that yields predetermined AG-UI events */
function createMockStreamFn(
	events: StreamChunk[]
): StreamFn {
	return async function* () {
		for (const event of events) {
			yield event
		}
	}
}

/** Create a simple text response stream (no tool calls) */
function textResponseStream(
	text: string,
	runId = 'run_1'
): StreamChunk[] {
	return [
		{ type: 'RUN_STARTED', runId, timestamp: Date.now() },
		{
			type: 'TEXT_MESSAGE_START',
			messageId: 'msg_1',
			role: 'assistant' as const,
			timestamp: Date.now()
		},
		{
			type: 'TEXT_MESSAGE_CONTENT',
			messageId: 'msg_1',
			delta: text,
			timestamp: Date.now()
		},
		{
			type: 'TEXT_MESSAGE_END',
			messageId: 'msg_1',
			timestamp: Date.now()
		},
		{
			type: 'RUN_FINISHED',
			runId,
			finishReason: 'stop' as const,
			usage: {
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15
			},
			timestamp: Date.now()
		}
	]
}

/** Create a tool call response stream */
function toolCallResponseStream(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	runId = 'run_1'
): StreamChunk[] {
	return [
		{ type: 'RUN_STARTED', runId, timestamp: Date.now() },
		{
			type: 'TOOL_CALL_START',
			toolCallId,
			toolName,
			timestamp: Date.now()
		},
		{
			type: 'TOOL_CALL_ARGS',
			toolCallId,
			delta: JSON.stringify(args),
			timestamp: Date.now()
		},
		{
			type: 'TOOL_CALL_END',
			toolCallId,
			toolName,
			input: args,
			timestamp: Date.now()
		},
		{
			type: 'RUN_FINISHED',
			runId,
			finishReason: 'tool_calls' as const,
			usage: {
				promptTokens: 10,
				completionTokens: 15,
				totalTokens: 25
			},
			timestamp: Date.now()
		}
	]
}

const mockAdapter = {} as AnyTextAdapter

function createMockModel() {
	return {
		id: 'claude-sonnet-4-6',
		name: 'Claude Sonnet 4.6',
		provider: 'anthropic' as const,
		reasoning: false,
		input: ['text' as const],
		cost: {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75
		},
		contextWindow: 200000,
		maxTokens: 8192
	}
}

async function collectEvents(
	stream: AsyncIterable<AgentEvent>
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = []
	for await (const event of stream) {
		events.push(event)
	}
	return events
}

// ============================================================================
// Tests
// ============================================================================

describe('agentLoop', () => {
	test('basic text response emits correct event sequence', async () => {
		const streamFn = createMockStreamFn(
			textResponseStream('Hello!')
		)

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const types = events.map(e => e.type)

		expect(types).toContain('agent_start')
		expect(types).toContain('turn_start')
		expect(types).toContain('message_start')
		expect(types).toContain('message_update')
		expect(types).toContain('message_end')
		expect(types).toContain('turn_end')
		expect(types).toContain('agent_end')

		// First message events should be for the user prompt
		const firstMsgStart = events.find(
			e => e.type === 'message_start'
		)
		expect(
			firstMsgStart?.type === 'message_start' &&
				firstMsgStart.message.role
		).toBe('user')

		// Should have an assistant message
		const msgEnd = events.filter(
			e =>
				e.type === 'message_end' &&
				e.message.role === 'assistant'
		)
		expect(msgEnd.length).toBe(1)

		const assistantMsg = (
			msgEnd[0] as {
				type: 'message_end'
				message: AssistantMessage
			}
		).message
		expect(assistantMsg.content[0]).toEqual({
			type: 'text',
			text: 'Hello!'
		})
		expect(assistantMsg.stopReason).toBe('stop')
		expect(assistantMsg.provider).toBe('anthropic')
		expect(assistantMsg.model).toBe('claude-sonnet-4-6')
	})

	test('tool call triggers execution and result events', async () => {
		const calculatorTool: AgentTool = {
			name: 'calculate',
			description: 'Calculate a math expression',
			parameters: v.object({ expression: v.string() }),
			label: 'Calculator',
			execute: async (_id, params) => ({
				content: [{ type: 'text', text: '42' }],
				details: { expression: params.expression }
			})
		}

		// First call returns tool call, second call returns text
		let callCount = 0
		const streamFn: StreamFn = async function* (_options) {
			callCount++
			if (callCount === 1) {
				yield* toolCallResponseStream('tc_1', 'calculate', {
					expression: '6*7'
				})
			} else {
				yield* textResponseStream('The answer is 42')
			}
		}

		const context: AgentContext = {
			systemPrompt: 'You are a calculator',
			messages: [],
			tools: [calculatorTool]
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'What is 6*7?' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)
		const types = events.map(e => e.type)

		// Should have tool execution events
		expect(types).toContain('tool_execution_start')
		expect(types).toContain('tool_execution_end')

		// Tool loop is internal to one turn when using streamFn
		const turnStarts = events.filter(
			e => e.type === 'turn_start'
		)
		expect(turnStarts.length).toBeGreaterThanOrEqual(1)

		// Tool result should be in events
		const toolEnd = events.find(
			e => e.type === 'tool_execution_end'
		)
		expect(
			toolEnd?.type === 'tool_execution_end' &&
				toolEnd.isError
		).toBe(false)
	})

	test('tool not found produces error result', async () => {
		// Second call returns text (after tool result)
		let callCount = 0
		const dynamicStreamFn: StreamFn = async function* () {
			callCount++
			if (callCount === 1) {
				yield* toolCallResponseStream(
					'tc_1',
					'nonexistent',
					{}
				)
			} else {
				yield* textResponseStream('Sorry, tool not found')
			}
		}

		const context: AgentContext = {
			systemPrompt: '',
			messages: [],
			tools: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Use a tool' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			dynamicStreamFn
		)
		const events = await collectEvents(stream)

		const toolEnd = events.find(
			e => e.type === 'tool_execution_end'
		)
		expect(
			toolEnd?.type === 'tool_execution_end' &&
				toolEnd.isError
		).toBe(true)
	})

	test('steering messages interrupt tool execution', async () => {
		let toolExecutionCount = 0
		const slowTool: AgentTool = {
			name: 'slow_task',
			description: 'A slow task',
			parameters: v.object({ id: v.number() }),
			label: 'Slow',
			execute: async () => {
				toolExecutionCount++
				return {
					content: [
						{
							type: 'text',
							text: `done ${toolExecutionCount}`
						}
					],
					details: {}
				}
			}
		}

		// Return two tool calls, then text
		let callCount = 0
		const streamFn: StreamFn = async function* () {
			callCount++
			if (callCount === 1) {
				// Two tool calls in one response
				yield {
					type: 'RUN_STARTED',
					runId: 'r1',
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_START',
					toolCallId: 'tc_1',
					toolName: 'slow_task',
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_ARGS',
					toolCallId: 'tc_1',
					delta: '{"id":1}',
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_END',
					toolCallId: 'tc_1',
					toolName: 'slow_task',
					input: { id: 1 },
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_START',
					toolCallId: 'tc_2',
					toolName: 'slow_task',
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_ARGS',
					toolCallId: 'tc_2',
					delta: '{"id":2}',
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'TOOL_CALL_END',
					toolCallId: 'tc_2',
					toolName: 'slow_task',
					input: { id: 2 },
					timestamp: Date.now()
				} as StreamChunk
				yield {
					type: 'RUN_FINISHED',
					runId: 'r1',
					finishReason: 'tool_calls',
					usage: {
						promptTokens: 10,
						completionTokens: 10,
						totalTokens: 20
					},
					timestamp: Date.now()
				} as StreamChunk
			} else {
				yield* textResponseStream('Acknowledged steering')
			}
		}

		let steeringReturned = false
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			getSteeringMessages: async () => {
				// Return steering after first tool execution
				if (!steeringReturned && toolExecutionCount >= 1) {
					steeringReturned = true
					return [
						{
							role: 'user' as const,
							content: [
								{ type: 'text' as const, text: 'Stop!' }
							],
							timestamp: Date.now()
						}
					]
				}
				return []
			}
		}

		const context: AgentContext = {
			systemPrompt: '',
			messages: [],
			tools: [slowTool]
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Do two tasks' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		// Only one tool should have actually executed
		expect(toolExecutionCount).toBe(1)

		// Second tool should be skipped
		const toolEnds = events.filter(
			e => e.type === 'tool_execution_end'
		)
		expect(toolEnds.length).toBe(2)
		const skipped = toolEnds[1]
		expect(
			skipped.type === 'tool_execution_end' &&
				skipped.isError
		).toBe(true)
	})

	test('follow-up messages continue after agent would stop', async () => {
		let callCount = 0
		const streamFn: StreamFn = async function* () {
			callCount++
			yield* textResponseStream(`Response ${callCount}`)
		}

		let followUpReturned = false
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			getFollowUpMessages: async () => {
				if (!followUpReturned) {
					followUpReturned = true
					return [
						{
							role: 'user' as const,
							content: [
								{
									type: 'text' as const,
									text: 'Also do this'
								}
							],
							timestamp: Date.now()
						}
					]
				}
				return []
			}
		}

		const context: AgentContext = {
			systemPrompt: '',
			messages: []
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'First task' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		// Should have two assistant responses (original + follow-up)
		const assistantMsgEnds = events.filter(
			e =>
				e.type === 'message_end' &&
				e.message.role === 'assistant'
		)
		expect(assistantMsgEnds.length).toBe(2)
		expect(callCount).toBe(2)
	})

	test('error in stream produces error assistant message', async () => {
		const streamFn: StreamFn = async function* () {
			yield {
				type: 'RUN_STARTED',
				runId: 'r1',
				timestamp: Date.now()
			} as StreamChunk
			yield {
				type: 'RUN_ERROR',
				error: { message: 'Rate limit exceeded' },
				timestamp: Date.now()
			} as StreamChunk
		}

		const context: AgentContext = {
			systemPrompt: '',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			// Disable retry so the error propagates immediately as a single assistant message
			retry: { maxAttempts: 1 }
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const agentEnd = events.find(
			e => e.type === 'agent_end'
		)
		expect(agentEnd).toBeDefined()

		const assistantMsgs = events.filter(
			e =>
				e.type === 'message_end' &&
				e.message.role === 'assistant'
		)
		expect(assistantMsgs.length).toBe(1)
		const msg = (
			assistantMsgs[0] as {
				type: 'message_end'
				message: AssistantMessage
			}
		).message
		expect(msg.stopReason).toBe('error')
		expect(msg.errorMessage).toBe('Rate limit exceeded')
	})
})

describe('agentLoopContinue', () => {
	test('throws with empty messages', () => {
		const context: AgentContext = {
			systemPrompt: '',
			messages: []
		}
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		expect(() =>
			agentLoopContinue(context, config)
		).toThrow('Cannot continue: no messages in context')
	})

	test('throws when last message is assistant', () => {
		const context: AgentContext = {
			systemPrompt: '',
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Hi' }],
					provider: 'anthropic',
					model: 'test',
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
					timestamp: Date.now()
				}
			]
		}
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		expect(() =>
			agentLoopContinue(context, config)
		).toThrow(
			'Cannot continue from message role: assistant'
		)
	})

	test('continues from user message', async () => {
		const streamFn = createMockStreamFn(
			textResponseStream('Continued!')
		)

		const context: AgentContext = {
			systemPrompt: '',
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Continue from here' }
					],
					timestamp: Date.now()
				}
			]
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
		}

		const stream = agentLoopContinue(
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const types = events.map(e => e.type)
		expect(types).toContain('agent_start')
		expect(types).toContain('agent_end')

		const assistantMsgs = events.filter(
			e =>
				e.type === 'message_end' &&
				e.message.role === 'assistant'
		)
		expect(assistantMsgs.length).toBe(1)
	})
})

describe('transformContext', () => {
	test('is called with messages and signal, and transformed output is used', async () => {
		let transformCalledWith: {
			messages: AgentMessage[]
			signal?: AbortSignal
		} | null = null

		const streamFn = createMockStreamFn(
			textResponseStream('Response')
		)

		const abortController = new AbortController()

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			transformContext: async (messages, signal) => {
				// Capture a snapshot — the original array gets mutated later by runLoop
				transformCalledWith = {
					messages: [...messages],
					signal
				}
				// Simulate context trimming: only keep the last message
				return messages.slice(-1)
			}
		}

		const context: AgentContext = {
			systemPrompt: 'Test',
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'Old message' }],
					timestamp: 1000
				}
			]
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'New message' }],
				timestamp: 2000
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			abortController.signal,
			streamFn
		)
		await collectEvents(stream)

		// transformContext should have been called
		expect(transformCalledWith).not.toBeNull()
		// It should receive the full context (old + new messages)
		expect(transformCalledWith!.messages.length).toBe(2)
		expect(transformCalledWith!.messages[0].role).toBe(
			'user'
		)
		expect(transformCalledWith!.messages[1].role).toBe(
			'user'
		)
		// It should receive the abort signal
		expect(transformCalledWith!.signal).toBe(
			abortController.signal
		)
	})
})

// ============================================================================
// Runtime guardrail tests
// ============================================================================

describe('runtime guardrails', () => {
	test('max model calls limit triggers limit_hit and ends run', async () => {
		let callCount = 0
		// StreamFn that tracks call count
		const streamFn: StreamFn = async function* () {
			callCount++
			for (const event of textResponseStream(
				`Response ${callCount}`
			)) {
				yield event
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const followUps = [
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'More 1' }
				],
				timestamp: Date.now()
			},
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'More 2' }
				],
				timestamp: Date.now()
			},
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'More 3' }
				],
				timestamp: Date.now()
			}
		]
		let followUpIdx = 0

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxModelCalls: 2
			},
			getFollowUpMessages: async () => {
				if (followUpIdx < followUps.length) {
					return [followUps[followUpIdx++]]
				}
				return []
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		// Should have a limit_hit event
		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(1)

		const limitHit = limitHitEvents[0] as Extract<
			AgentEvent,
			{ type: 'limit_hit' }
		>
		expect(limitHit.limit).toBe('max_model_calls')
		expect(limitHit.threshold).toBe(2)
		// With > semantics: 2 calls complete, then the pre-call increment
		// for the 3rd call pushes modelCallCount to 3 which exceeds the limit.
		expect(limitHit.observed).toBe(3)
		expect(limitHit.scope).toBe('run')
		expect(limitHit.action).toBe('hard_stop')
		expect(limitHit.usageSnapshot.modelCalls).toBe(3)

		// Should have an agent_end
		const agentEndEvents = events.filter(
			e => e.type === 'agent_end'
		)
		expect(agentEndEvents.length).toBe(1)

		// The terminal assistant message should mention the limit
		const messageEnds = events.filter(
			e => e.type === 'message_end'
		)
		const lastMsgEnd = messageEnds[
			messageEnds.length - 1
		] as Extract<AgentEvent, { type: 'message_end' }>
		if (lastMsgEnd.message.role === 'assistant') {
			const asst = lastMsgEnd.message as AssistantMessage
			expect(asst.errorMessage).toBe(
				'guardrail:max_model_calls'
			)
		}
	})

	test('max cost limit triggers limit_hit and ends run', async () => {
		// Each call costs ~0.0001 (from mapTanStackUsage with mock model)
		// We'll use a very low cost limit
		let callCount = 0
		const streamFn: StreamFn = async function* () {
			callCount++
			for (const event of textResponseStream(
				`Response ${callCount}`
			)) {
				yield event
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		// Queue 10 follow-ups so we'd loop many times without limits
		const followUps: AgentMessage[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				role: 'user' as const,
				content: [
					{
						type: 'text' as const,
						text: `Follow-up ${i}`
					}
				],
				timestamp: Date.now()
			})
		)
		let followUpIdx = 0

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxCostUsd: 0.00001 // Very low — should trigger after first call
			},
			getFollowUpMessages: async () => {
				if (followUpIdx < followUps.length) {
					return [followUps[followUpIdx++]]
				}
				return []
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(1)

		const limitHit = limitHitEvents[0] as Extract<
			AgentEvent,
			{ type: 'limit_hit' }
		>
		expect(limitHit.limit).toBe('max_cost_usd')
		expect(limitHit.scope).toBe('run')
		expect(limitHit.action).toBe('hard_stop')
	})

	test('wall-clock limit triggers limit_hit after timeout', async () => {
		// Create a slow streamFn that takes ~200ms per call
		const streamFn: StreamFn = async function* () {
			await new Promise(r => setTimeout(r, 200))
			for (const event of textResponseStream(
				'Slow response'
			)) {
				yield event
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		// Many follow-ups to keep the loop going
		let followUpIdx = 0
		const followUps: AgentMessage[] = Array.from(
			{ length: 20 },
			(_, i) => ({
				role: 'user' as const,
				content: [
					{
						type: 'text' as const,
						text: `Follow-up ${i}`
					}
				],
				timestamp: Date.now()
			})
		)

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxWallClockMs: 300 // 300ms — should trigger during 2nd call
			},
			getFollowUpMessages: async () => {
				if (followUpIdx < followUps.length) {
					return [followUps[followUpIdx++]]
				}
				return []
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		// Wall-clock abort goes through the abort path and may manifest
		// as a limit_hit event or as an aborted stop reason.
		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		const agentEndEvents = events.filter(
			e => e.type === 'agent_end'
		)

		// The run must have ended
		expect(agentEndEvents.length).toBe(1)

		// The wall-clock limit should have triggered a limit_hit event
		expect(limitHitEvents.length).toBeGreaterThan(0)

		// Check that it didn't run all 20 follow-ups
		const turnStarts = events.filter(
			e => e.type === 'turn_start'
		)
		expect(turnStarts.length).toBeLessThan(20)
	})

	test('user abort still yields aborted (not limit_hit)', async () => {
		const abortController = new AbortController()
		let callCount = 0

		const streamFn: StreamFn = async function* () {
			callCount++
			if (callCount === 1) {
				// Abort during first call
				abortController.abort()
			}
			for (const event of textResponseStream(
				`Response ${callCount}`
			)) {
				yield event
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxModelCalls: 100 // High limit — shouldn't trigger
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			abortController.signal,
			streamFn
		)
		const events = await collectEvents(stream)

		// Should NOT have limit_hit
		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(0)

		// Should have agent_end
		const agentEndEvents = events.filter(
			e => e.type === 'agent_end'
		)
		expect(agentEndEvents.length).toBe(1)
	})

	test('no limits set means no limit_hit events', async () => {
		const streamFn = createMockStreamFn(
			textResponseStream('Hello!')
		)

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter
			// No runtimeLimits set
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(0)
	})

	test('disabled limits (0 or negative) are ignored', async () => {
		let callCount = 0
		const streamFn: StreamFn = async function* () {
			callCount++
			for (const event of textResponseStream(
				`Response ${callCount}`
			)) {
				yield event
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
				timestamp: Date.now()
			}
		]

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: []
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxModelCalls: 0, // Disabled
				maxCostUsd: -1, // Disabled
				maxWallClockMs: 0 // Disabled
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		// Should complete normally without limit_hit
		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(0)

		const agentEndEvents = events.filter(
			e => e.type === 'agent_end'
		)
		expect(agentEndEvents.length).toBe(1)
	})

	test('max model calls with streamFn tool loop path', async () => {
		const echoTool: AgentTool = {
			name: 'echo',
			description: 'Echoes text',
			parameters: v.object({
				text: v.string()
			}),
			label: 'echo',
			execute: async (_id, params) => ({
				content: [
					{
						type: 'text' as const,
						text: params.text
					}
				],
				details: {}
			})
		}

		let callCount = 0
		// StreamFn path: returns tool calls each time
		const streamFn: StreamFn = async function* () {
			callCount++
			if (callCount <= 5) {
				for (const event of toolCallResponseStream(
					`tc_${callCount}`,
					'echo',
					{ text: `echo ${callCount}` },
					`run_${callCount}`
				)) {
					yield event
				}
			} else {
				for (const event of textResponseStream(
					'Done',
					`run_${callCount}`
				)) {
					yield event
				}
			}
		}

		const prompts: AgentMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: 'Run echo' }],
				timestamp: Date.now()
			}
		]

		const context: AgentContext = {
			systemPrompt: 'Be helpful',
			messages: [],
			tools: [echoTool]
		}

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			retry: { maxAttempts: 1 },
			runtimeLimits: {
				maxModelCalls: 3 // Limit to 3 model calls
			}
		}

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn
		)
		const events = await collectEvents(stream)

		const limitHitEvents = events.filter(
			e => e.type === 'limit_hit'
		)
		expect(limitHitEvents.length).toBe(1)

		const limitHit = limitHitEvents[0] as Extract<
			AgentEvent,
			{ type: 'limit_hit' }
		>
		expect(limitHit.limit).toBe('max_model_calls')
		expect(limitHit.threshold).toBe(3)
		// With > semantics: 3 calls complete, then the pre-call increment
		// for the 4th pushes modelCallCount to 4 which exceeds the limit.
		expect(limitHit.usageSnapshot.modelCalls).toBe(4)
	})
})
