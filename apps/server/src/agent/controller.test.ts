import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { AgentController } from './controller'
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
	return mkdtempSync(join(tmpdir(), 'controller-test-'))
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

describe('AgentController', () => {
	let tmpDir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let controller: AgentController

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
		store = new RealtimeStore(eventStore)
		controller = new AgentController(store, {
			adapter: createMockAdapter(),
			systemPrompt: 'You are a test assistant.'
		})
	})

	afterEach(() => {
		controller.dispose()
		eventStore.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('getOrCreate creates agent and session', () => {
		const agent = controller.getOrCreate('session-1')

		expect(agent).toBeDefined()
		expect(agent.state.systemPrompt).toBe(
			'You are a test assistant.'
		)
		expect(eventStore.getSession('session-1')).toBeDefined()
	})

	test('getOrCreate returns same agent for same sessionId', () => {
		const agent1 = controller.getOrCreate('session-1')
		const agent2 = controller.getOrCreate('session-1')

		expect(agent1).toBe(agent2)
	})

	test('getOrCreate returns different agents for different sessionIds', () => {
		const agent1 = controller.getOrCreate('session-1')
		const agent2 = controller.getOrCreate('session-2')

		expect(agent1).not.toBe(agent2)
	})

	test('hasSession returns false for non-existent session', () => {
		expect(controller.hasSession('nonexistent')).toBe(false)
	})

	test('hasSession returns true after getOrCreate', () => {
		controller.getOrCreate('session-1')
		expect(controller.hasSession('session-1')).toBe(true)
	})

	test('loadHistory returns empty for new session', () => {
		controller.getOrCreate('session-1')
		const history = controller.loadHistory('session-1')
		expect(history).toEqual([])
	})

	test('handleMessage routes to prompt when idle', async () => {
		// Persist a user message first (like the chat route does)
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		const { runId, routed } =
			await controller.handleMessage('session-1', 'Hello')

		expect(runId).toBeDefined()
		expect(routed).toBe('prompt')

		// Wait for agent to finish
		const agent = controller.getOrCreate('session-1')
		await agent.waitForIdle()
	})

	test('handleMessage routes to followUp when busy', async () => {
		// Persist user messages
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'First' }],
			timestamp: Date.now()
		})

		// Start first message
		const result1 = await controller.handleMessage(
			'session-1',
			'First'
		)
		expect(result1.routed).toBe('prompt')

		// Send second message while agent is busy
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Second' }],
			timestamp: Date.now()
		})

		const result2 = await controller.handleMessage(
			'session-1',
			'Second'
		)
		expect(result2.routed).toBe('followUp')

		// Wait for agent to finish (should process both)
		const agent = controller.getOrCreate('session-1')
		await agent.waitForIdle()
	})

	test('steer throws for non-existent agent', () => {
		expect(() =>
			controller.steer('nonexistent', 'Hey')
		).toThrow('Agent not found for session nonexistent')
	})

	test('abort throws for non-existent agent', () => {
		expect(() => controller.abort('nonexistent')).toThrow(
			'Agent not found for session nonexistent'
		)
	})

	test('evict removes agent from memory', () => {
		controller.getOrCreate('session-1')
		controller.evict('session-1')

		// Should create a new agent
		const newAgent = controller.getOrCreate('session-1')
		expect(newAgent.state.messages.length).toBe(0)
	})

	test('watch is idempotent', () => {
		// Should not throw when called multiple times
		controller.watch('session-1')
		controller.watch('session-1')
		controller.watch('session-1')
	})
})
