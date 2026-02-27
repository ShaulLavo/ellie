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
import { seedWorkspace } from './workspace'
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
	let workspaceDir: string

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
		store = new RealtimeStore(eventStore, 'test-session')
		workspaceDir = seedWorkspace(tmpDir)
		controller = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir
		})
	})

	afterEach(() => {
		controller.dispose()
		eventStore.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('hasSession returns false for non-existent session', () => {
		expect(controller.hasSession('nonexistent')).toBe(false)
	})

	test('loadHistory returns empty for new session', () => {
		store.ensureSession('session-1')
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
	})

	test('handleMessage routes to followUp when busy on same session', async () => {
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
	})

	test('handleMessage queues cross-session when busy', async () => {
		store.ensureSession('session-1')
		store.ensureSession('session-2')

		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'First' }],
			timestamp: Date.now()
		})

		// Start first message on session-1
		const result1 = await controller.handleMessage(
			'session-1',
			'First'
		)
		expect(result1.routed).toBe('prompt')

		// Send message to session-2 while agent is busy
		store.appendEvent('session-2', 'user_message', {
			role: 'user',
			content: [
				{ type: 'text', text: 'Hello from session 2' }
			],
			timestamp: Date.now()
		})

		const result2 = await controller.handleMessage(
			'session-2',
			'Hello from session 2'
		)
		expect(result2.routed).toBe('queued')
	})

	test('steer throws for unbound session', () => {
		expect(() =>
			controller.steer('nonexistent', 'Hey')
		).toThrow('Agent not bound to session nonexistent')
	})

	test('abort throws for unbound session', () => {
		expect(() => controller.abort('nonexistent')).toThrow(
			'Agent not bound to session nonexistent'
		)
	})

	test('watch is idempotent', () => {
		// Should not throw when called multiple times
		controller.watch('session-1')
		controller.watch('session-1')
		controller.watch('session-1')
	})
})
