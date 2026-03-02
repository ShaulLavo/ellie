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

/** Standard stream chunks for a simple text response. */
function mockTextChunks(): StreamChunk[] {
	return [
		{
			type: 'RUN_STARTED',
			threadId: 't1',
			runId: 'r1'
		},
		{
			type: 'TEXT_MESSAGE_START',
			messageId: 'm1'
		},
		{
			type: 'TEXT_MESSAGE_CONTENT',
			messageId: 'm1',
			delta: 'Hello from mock!'
		},
		{
			type: 'TEXT_MESSAGE_END',
			messageId: 'm1'
		},
		{
			type: 'RUN_FINISHED',
			threadId: 't1',
			runId: 'r1',
			finishReason: 'stop',
			usage: {
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15
			}
		}
	] as unknown as StreamChunk[]
}

/**
 * Create a mock adapter that yields a simple text response.
 * Implements chatStream (used by TanStack's chat()) properly.
 */
function createMockAdapter(
	chunks?: StreamChunk[]
): AnyTextAdapter {
	const data = chunks ?? mockTextChunks()
	return {
		name: 'mock',
		chatStream: async function* () {
			for (const chunk of data) {
				yield chunk
			}
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

	test('guardrails do not crash the normal path when limit is not exceeded', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		// maxModelCalls=10 with a single-response adapter: the first call
		// uses 1 of the 10 budget, so the limit is never exceeded.
		const guardedController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			agentOptions: {
				guardrails: {
					runtimeLimits: { maxModelCalls: 10 }
				}
			}
		})

		try {
			const { routed } =
				await guardedController.handleMessage(
					'session-1',
					'Hello'
				)
			expect(routed).toBe('prompt')

			await new Promise(r => setTimeout(r, 500))

			const events = eventStore.query({
				sessionId: 'session-1'
			})
			const types = events.map(e => e.type)

			// Run completes normally — no limit_hit since 1 < 10
			expect(types).toContain('agent_start')
			expect(types).toContain('agent_end')
			expect(types).not.toContain('limit_hit')
		} finally {
			guardedController.dispose()
		}
	})

	test('limit_hit event is persisted when guardrail triggers', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		// With maxModelCalls=1, the first call uses the budget (count=1 >= 1).
		// The post-call checkpoint triggers limit_hit before a follow-up
		// turn can start.
		const guardedController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			agentOptions: {
				guardrails: {
					runtimeLimits: { maxModelCalls: 1 }
				}
			}
		})

		try {
			const { routed } =
				await guardedController.handleMessage(
					'session-1',
					'Hello'
				)
			expect(routed).toBe('prompt')

			// Queue a follow-up while the agent is processing, so the loop
			// has a reason to continue past the first call and hit the limit.
			await new Promise(r => setTimeout(r, 50))

			await new Promise(r => setTimeout(r, 1000))

			const events = eventStore.query({
				sessionId: 'session-1'
			})
			const types = events.map(e => e.type)

			expect(types).toContain('agent_start')
			expect(types).toContain('agent_end')

			// The post-call checkpoint fires after the first model call
			// because modelCallCount(1) >= maxModelCalls(1)
			expect(types).toContain('limit_hit')

			// Verify the limit_hit payload
			const limitHitRow = events.find(
				e => e.type === 'limit_hit'
			)
			expect(limitHitRow).toBeDefined()
			const payload = JSON.parse(
				limitHitRow!.payload as string
			) as { limit: string }
			expect(payload.limit).toBe('max_model_calls')
		} finally {
			guardedController.dispose()
		}
	})
})
