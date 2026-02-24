import { describe, expect, test } from 'bun:test'
import { Agent } from '../src/agent'
import type { AgentEvent, AgentMessage, StreamFn, AssistantMessage } from '../src/types'
import type { StreamChunk, AnyTextAdapter } from '@tanstack/ai'

// ============================================================================
// Test helpers
// ============================================================================

function textResponseStream(text: string): StreamChunk[] {
	return [
		{ type: 'RUN_STARTED', runId: 'r1', timestamp: Date.now() },
		{
			type: 'TEXT_MESSAGE_START',
			messageId: 'm1',
			role: 'assistant' as const,
			timestamp: Date.now()
		},
		{
			type: 'TEXT_MESSAGE_CONTENT',
			messageId: 'm1',
			delta: text,
			timestamp: Date.now()
		},
		{
			type: 'TEXT_MESSAGE_END',
			messageId: 'm1',
			timestamp: Date.now()
		},
		{
			type: 'RUN_FINISHED',
			runId: 'r1',
			finishReason: 'stop' as const,
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			timestamp: Date.now()
		}
	]
}

function createMockStreamFn(events: StreamChunk[]): StreamFn {
	return async function* () {
		for (const event of events) {
			yield event
		}
	}
}

const mockAdapter = {} as AnyTextAdapter

// ============================================================================
// Tests
// ============================================================================

describe('Agent', () => {
	test('default state has anthropic model', () => {
		const agent = new Agent()
		expect(agent.state.model.provider).toBe('anthropic')
		expect(agent.state.model.id).toBe('claude-sonnet-4-6')
		expect(agent.state.isStreaming).toBe(false)
		expect(agent.state.messages).toEqual([])
		expect(agent.state.thinkingLevel).toBe('off')
	})

	test('accepts initial state overrides', () => {
		const agent = new Agent({
			initialState: {
				systemPrompt: 'Be helpful',
				thinkingLevel: 'high'
			}
		})
		expect(agent.state.systemPrompt).toBe('Be helpful')
		expect(agent.state.thinkingLevel).toBe('high')
	})

	test('prompt throws without adapter', async () => {
		const agent = new Agent()
		await expect(agent.prompt('hi')).rejects.toThrow('No adapter configured')
	})

	test('prompt throws when already streaming', async () => {
		let resolve: () => void
		const blocker = new Promise<void>((r) => {
			resolve = r
		})

		const agent = new Agent({
			adapter: mockAdapter,
			streamFn: async function* (_options) {
				yield {
					type: 'RUN_STARTED',
					runId: 'r1',
					timestamp: Date.now()
				} as StreamChunk
				// Wait until unblocked
				await blocker
				yield* textResponseStream('done').slice(1)
			}
		})

		// Start first prompt (don't await)
		const p = agent.prompt('first')

		// Wait for streaming to start
		await Bun.sleep(20)

		await expect(agent.prompt('second')).rejects.toThrow('Agent is already processing')

		// Unblock
		resolve!()
		await p
	})

	test('prompt with string creates user message and gets response', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Hello!'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		await agent.prompt('Hi there')

		expect(agent.state.messages.length).toBe(2) // user + assistant
		expect(agent.state.messages[0].role).toBe('user')
		expect(agent.state.messages[1].role).toBe('assistant')

		const assistantMsg = agent.state.messages[1] as AssistantMessage
		expect(assistantMsg.content[0]).toEqual({ type: 'text', text: 'Hello!' })
		expect(assistantMsg.stopReason).toBe('stop')
	})

	test('prompt with AgentMessage array', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Got it'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		await agent.prompt([
			{
				role: 'user',
				content: [{ type: 'text', text: 'Message 1' }],
				timestamp: Date.now()
			}
		])

		expect(agent.state.messages.length).toBe(2)
	})

	test('subscribe receives events', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Hi'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		const events: AgentEvent[] = []
		const unsub = agent.subscribe((e) => events.push(e))

		await agent.prompt('Hello')
		unsub()

		const types = events.map((e) => e.type)
		expect(types).toContain('agent_start')
		expect(types).toContain('message_start')
		expect(types).toContain('message_end')
		expect(types).toContain('agent_end')
	})

	test('unsubscribe stops receiving events', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Hi'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		const events: AgentEvent[] = []
		const unsub = agent.subscribe((e) => events.push(e))
		unsub()

		await agent.prompt('Hello')

		expect(events.length).toBe(0)
	})

	test('state mutators work', () => {
		const agent = new Agent()

		agent.setSystemPrompt('New prompt')
		expect(agent.state.systemPrompt).toBe('New prompt')

		agent.setThinkingLevel('high')
		expect(agent.state.thinkingLevel).toBe('high')

		agent.setTools([])
		expect(agent.state.tools).toEqual([])
	})

	test('message management', () => {
		const agent = new Agent()
		const msg: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'test' }],
			timestamp: 1000
		}

		agent.appendMessage(msg)
		expect(agent.state.messages.length).toBe(1)

		agent.replaceMessages([msg, msg])
		expect(agent.state.messages.length).toBe(2)

		agent.clearMessages()
		expect(agent.state.messages.length).toBe(0)
	})

	test('steering queue management', () => {
		const agent = new Agent()
		const msg: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'steer' }],
			timestamp: 1000
		}

		expect(agent.hasQueuedMessages()).toBe(false)

		agent.steer(msg)
		expect(agent.hasQueuedMessages()).toBe(true)

		agent.clearSteeringQueue()
		expect(agent.hasQueuedMessages()).toBe(false)
	})

	test('follow-up queue management', () => {
		const agent = new Agent()
		const msg: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'follow-up' }],
			timestamp: 1000
		}

		agent.followUp(msg)
		expect(agent.hasQueuedMessages()).toBe(true)

		agent.clearFollowUpQueue()
		expect(agent.hasQueuedMessages()).toBe(false)
	})

	test('clearAllQueues clears both', () => {
		const agent = new Agent()
		const msg: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'msg' }],
			timestamp: 1000
		}

		agent.steer(msg)
		agent.followUp(msg)
		expect(agent.hasQueuedMessages()).toBe(true)

		agent.clearAllQueues()
		expect(agent.hasQueuedMessages()).toBe(false)
	})

	test('reset clears everything', () => {
		const agent = new Agent()
		const msg: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'msg' }],
			timestamp: 1000
		}

		agent.appendMessage(msg)
		agent.steer(msg)
		agent.followUp(msg)

		agent.reset()

		expect(agent.state.messages.length).toBe(0)
		expect(agent.state.isStreaming).toBe(false)
		expect(agent.state.streamMessage).toBeNull()
		expect(agent.state.error).toBeUndefined()
		expect(agent.hasQueuedMessages()).toBe(false)
	})

	test('waitForIdle resolves immediately when not streaming', async () => {
		const agent = new Agent()
		await agent.waitForIdle() // Should not hang
	})

	test('waitForIdle resolves after prompt completes', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Done'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		const promptPromise = agent.prompt('Go')
		await agent.waitForIdle()
		await promptPromise

		expect(agent.state.isStreaming).toBe(false)
	})

	test('abort sets error state', async () => {
		let resolve: () => void
		const blocker = new Promise<void>((r) => {
			resolve = r
		})

		const streamFn: StreamFn = async function* (options) {
			yield {
				type: 'RUN_STARTED',
				runId: 'r1',
				timestamp: Date.now()
			} as StreamChunk
			// Check abort between yields
			await blocker
			if (options.abortController?.signal.aborted) {
				yield {
					type: 'RUN_ERROR',
					error: { message: 'Aborted' },
					timestamp: Date.now()
				} as StreamChunk
				return
			}
			yield* textResponseStream('should not reach').slice(1)
		}

		const agent = new Agent({ adapter: mockAdapter, streamFn })

		const promptPromise = agent.prompt('Go')
		await Bun.sleep(20)
		agent.abort()
		resolve!()

		await promptPromise

		expect(agent.state.isStreaming).toBe(false)
		// The error should be set since we aborted
		expect(agent.state.error).toBeDefined()
	})

	test('steering mode defaults to one-at-a-time', () => {
		const agent = new Agent()
		expect(agent.getSteeringMode()).toBe('one-at-a-time')
	})

	test('follow-up mode defaults to one-at-a-time', () => {
		const agent = new Agent()
		expect(agent.getFollowUpMode()).toBe('one-at-a-time')
	})

	test('steering and follow-up mode setters', () => {
		const agent = new Agent()

		agent.setSteeringMode('all')
		expect(agent.getSteeringMode()).toBe('all')

		agent.setFollowUpMode('all')
		expect(agent.getFollowUpMode()).toBe('all')
	})

	test('continue throws with empty messages', async () => {
		const agent = new Agent({ adapter: mockAdapter })
		await expect(agent.continue()).rejects.toThrow('No messages to continue from')
	})

	test('continue throws when last message is assistant (no queued)', async () => {
		const streamFn = createMockStreamFn(textResponseStream('Hi'))
		const agent = new Agent({ adapter: mockAdapter, streamFn })

		await agent.prompt('Hello')
		// Last message is now assistant
		await expect(agent.continue()).rejects.toThrow('Cannot continue from message role: assistant')
	})

	test('isStreaming is true during prompt', async () => {
		let seenStreaming = false
		const streamFn: StreamFn = async function* () {
			yield* textResponseStream('Hello')
		}

		const agent = new Agent({ adapter: mockAdapter, streamFn })

		agent.subscribe((e) => {
			if (e.type === 'message_update') {
				seenStreaming = agent.state.isStreaming
			}
		})

		await agent.prompt('Hi')
		expect(seenStreaming).toBe(true)
		expect(agent.state.isStreaming).toBe(false)
	})
})
