import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { AgentManager } from './manager'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../lib/realtime-store'
import type {
	AnyTextAdapter,
	StreamChunk
} from '@tanstack/ai'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

// ============================================================================
// Test helpers
// ============================================================================

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'manager-test-'))
}

/**
 * Create a mock adapter that yields a simple text response.
 */
function createMockAdapter(): AnyTextAdapter {
	return {
		name: 'mock',
		chat: async function* (): AsyncIterable<StreamChunk> {
			yield {
				type: 'RUN_STARTED',
				threadId: 't1',
				runId: 'r1'
			} as unknown as StreamChunk
			yield {
				type: 'TEXT_MESSAGE_START',
				messageId: 'm1'
			} as unknown as StreamChunk
			yield {
				type: 'TEXT_MESSAGE_CONTENT',
				messageId: 'm1',
				delta: 'Hello from mock!'
			} as unknown as StreamChunk
			yield {
				type: 'TEXT_MESSAGE_END',
				messageId: 'm1'
			} as unknown as StreamChunk
			yield {
				type: 'RUN_FINISHED',
				threadId: 't1',
				runId: 'r1',
				finishReason: 'stop',
				usage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15
				}
			} as unknown as StreamChunk
		}
	} as unknown as AnyTextAdapter
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentManager', () => {
	let tmpDir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let manager: AgentManager

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
		store = new RealtimeStore(eventStore)
		manager = new AgentManager(store, {
			adapter: createMockAdapter(),
			systemPrompt: 'You are a test assistant.'
		})
	})

	afterEach(() => {
		eventStore.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('getOrCreate creates agent and session', () => {
		const agent = manager.getOrCreate('session-1')

		expect(agent).toBeDefined()
		expect(agent.state.systemPrompt).toBe(
			'You are a test assistant.'
		)
		expect(eventStore.getSession('session-1')).toBeDefined()
	})

	test('getOrCreate returns same agent for same sessionId', () => {
		const agent1 = manager.getOrCreate('session-1')
		const agent2 = manager.getOrCreate('session-1')

		expect(agent1).toBe(agent2)
	})

	test('getOrCreate returns different agents for different sessionIds', () => {
		const agent1 = manager.getOrCreate('session-1')
		const agent2 = manager.getOrCreate('session-2')

		expect(agent1).not.toBe(agent2)
	})

	test('hasSession returns false for non-existent session', () => {
		expect(manager.hasSession('nonexistent')).toBe(false)
	})

	test('hasSession returns true after getOrCreate', () => {
		manager.getOrCreate('session-1')
		expect(manager.hasSession('session-1')).toBe(true)
	})

	test('loadHistory returns empty for new session', () => {
		manager.getOrCreate('session-1')
		const history = manager.loadHistory('session-1')
		expect(history).toEqual([])
	})

	test('prompt creates events and persists user message', async () => {
		const { runId } = await manager.prompt(
			'session-1',
			'Hello'
		)

		expect(runId).toBeDefined()
		expect(typeof runId).toBe('string')
		expect(runId.length).toBeGreaterThan(0)

		// Wait for agent to finish
		const agent = manager.getOrCreate('session-1')
		await agent.waitForIdle()

		// Check messages were persisted
		const history = manager.loadHistory('session-1')
		expect(history.length).toBeGreaterThanOrEqual(2) // user + assistant

		// First message should be the user message
		const userMsg = history.find(m => m.role === 'user')
		expect(userMsg).toBeDefined()
		expect(
			(
				userMsg as unknown as {
					content: { text: string }[]
				}
			)?.content[0]?.text
		).toBe('Hello')

		// Should have an assistant response
		const assistantMsg = history.find(
			m => m.role === 'assistant'
		)
		expect(assistantMsg).toBeDefined()
	})

	test('prompt persists user_message event in event store', async () => {
		const { runId } = await manager.prompt(
			'session-1',
			'Test'
		)

		// User message event should exist
		const userEvents = eventStore.query({
			sessionId: 'session-1',
			types: ['user_message']
		})
		expect(userEvents.length).toBe(1)
		expect(JSON.parse(userEvents[0].payload)).toMatchObject(
			{
				role: 'user',
				content: [{ type: 'text', text: 'Test' }]
			}
		)
		expect(userEvents[0].runId).toBe(runId)

		// Wait for agent to finish
		const agent = manager.getOrCreate('session-1')
		await agent.waitForIdle()
	})

	test('steer throws for non-existent agent', () => {
		expect(() =>
			manager.steer('nonexistent', 'Hey')
		).toThrow('Agent not found for session nonexistent')
	})

	test('abort throws for non-existent agent', () => {
		expect(() => manager.abort('nonexistent')).toThrow(
			'Agent not found for session nonexistent'
		)
	})

	test('evict removes agent from memory', () => {
		manager.getOrCreate('session-1')
		manager.evict('session-1')

		// Should create a new agent
		const newAgent = manager.getOrCreate('session-1')
		expect(newAgent.state.messages.length).toBe(0)
	})

	test('multiple prompts accumulate history', async () => {
		await manager.prompt('session-1', 'First message')
		const agent = manager.getOrCreate('session-1')
		await agent.waitForIdle()

		await manager.prompt('session-1', 'Second message')
		await agent.waitForIdle()

		const history = manager.loadHistory('session-1')

		// Should have at least 4 messages: user1, assistant1, user2, assistant2
		const userMsgs = history.filter(m => m.role === 'user')
		const assistantMsgs = history.filter(
			m => m.role === 'assistant'
		)

		expect(userMsgs.length).toBe(2)
		expect(assistantMsgs.length).toBe(2)
	})
})
