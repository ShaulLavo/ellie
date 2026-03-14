import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { AgentController } from './controller'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../../lib/realtime-store'
import { seedWorkspace } from '../workspace'
import type { MemoryOrchestrator } from '../memory-orchestrator'
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
 * @param chunks   Optional custom chunks to yield.
 * @param delayMs  Optional delay between chunks (useful for keeping isStreaming true).
 */
function createMockAdapter(
	chunks?: StreamChunk[],
	delayMs?: number
): AnyTextAdapter {
	const data = chunks ?? mockTextChunks()
	return {
		name: 'mock',
		chatStream: async function* () {
			for (const chunk of data) {
				if (delayMs) {
					await new Promise(r => setTimeout(r, delayMs))
				}
				yield chunk
			}
		}
	} as unknown as AnyTextAdapter
}

/**
 * Create a mock MemoryOrchestrator for testing.
 */
function createMockMemory(
	recallResult?: {
		payload: Record<string, unknown>
		contextBlock: string
	} | null,
	retainResult?: Record<string, unknown> | null
): MemoryOrchestrator {
	return {
		async recall(_query: string) {
			return (
				recallResult ?? {
					payload: {
						parts: [
							{
								type: 'memory',
								text: 'Recalled 1 memory',
								count: 1,
								memories: [{ text: 'Test memory' }],
								duration_ms: 50
							}
						],
						query: _query,
						bankIds: ['bank-1'],
						timestamp: Date.now()
					},
					contextBlock:
						'<recalled_memories>\n  1. Test memory\n</recalled_memories>'
				}
			)
		},
		async evaluateRetain(
			_sessionId: string,
			_force?: boolean
		) {
			if (retainResult === null) return null
			return (
				retainResult ?? {
					parts: [
						{
							type: 'memory-retain',
							factsStored: 2,
							facts: ['fact1', 'fact2'],
							duration_ms: 100
						}
					],
					trigger: 'turn_count',
					bankIds: ['bank-1'],
					seqFrom: 1,
					seqTo: 5,
					timestamp: Date.now()
				}
			)
		}
	} as unknown as MemoryOrchestrator
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
			workspaceDir,
			dataDir: tmpDir
		})
	})

	afterEach(() => {
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

	test('handleMessage backfills runId on user_message row', async () => {
		store.ensureSession('session-1')
		const row = store.appendEvent(
			'session-1',
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'Hello' }],
				timestamp: Date.now()
			}
		)

		// Row initially has no runId
		expect(row.runId).toBeNull()

		const { runId, routed } =
			await controller.handleMessage(
				'session-1',
				'Hello',
				row.id
			)

		expect(routed).toBe('prompt')

		// Verify runId was backfilled
		const events = eventStore.query({
			sessionId: 'session-1',
			types: ['user_message']
		})
		expect(events[0]!.runId).toBe(runId)
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
			dataDir: tmpDir,
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

			// Run completes normally with only durable lifecycle rows.
			expect(types).toContain('agent_start')
			expect(types).toContain('run_closed')
			expect(types).not.toContain('limit_hit')
		} finally {
		}
	})

	test('memory recall events are persisted to the session DB', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		const memoryController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			dataDir: tmpDir,
			memory: createMockMemory()
		})

		try {
			const { routed } =
				await memoryController.handleMessage(
					'session-1',
					'Hello'
				)
			expect(routed).toBe('prompt')

			// Wait for agent to complete
			await new Promise(r => setTimeout(r, 500))

			const events = eventStore.query({
				sessionId: 'session-1'
			})
			const types = events.map(e => e.type)

			expect(types).toContain('agent_start')
			expect(types).toContain('run_closed')
			expect(types).toContain('memory_recall')
		} finally {
		}
	})

	test('memory recall event contains payload with query and parts', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'test query' }],
			timestamp: Date.now()
		})

		const memoryController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			dataDir: tmpDir,
			memory: createMockMemory()
		})

		try {
			await memoryController.handleMessage(
				'session-1',
				'test query'
			)

			await new Promise(r => setTimeout(r, 500))

			const recallEvents = eventStore.query({
				sessionId: 'session-1',
				types: ['memory_recall']
			})

			expect(recallEvents).toHaveLength(1)
			const payload = JSON.parse(recallEvents[0].payload)
			expect(payload.query).toBe('test query')
			expect(payload.parts).toBeDefined()
		} finally {
		}
	})

	test('no memory_retain event when retain returns null', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		const memoryController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			dataDir: tmpDir,
			memory: createMockMemory(undefined, null)
		})

		try {
			await memoryController.handleMessage(
				'session-1',
				'Hello'
			)

			await new Promise(r => setTimeout(r, 1000))

			const retainEvents = eventStore.query({
				sessionId: 'session-1',
				types: ['memory_retain']
			})

			// Retain returns null when thresholds are not met
			expect(retainEvents).toHaveLength(0)
		} finally {
		}
	})

	test('memory_retain event is persisted when retain triggers', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		const memoryController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			dataDir: tmpDir,
			memory: createMockMemory()
		})

		try {
			await memoryController.handleMessage(
				'session-1',
				'Hello'
			)

			await new Promise(r => setTimeout(r, 1000))

			const retainEvents = eventStore.query({
				sessionId: 'session-1',
				types: ['memory_retain']
			})

			expect(retainEvents).toHaveLength(1)
			expect(retainEvents[0]!.runId).toBeNull()
			const payload = JSON.parse(retainEvents[0].payload)
			expect(payload.trigger).toBe('turn_count')
			expect(payload.parts[0].factsStored).toBe(2)
		} finally {
		}
	})

	test('retain completes before the next run starts', async () => {
		store.ensureSession('session-1')
		const firstUserRow = store.appendEvent(
			'session-1',
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'First' }],
				timestamp: Date.now()
			}
		)

		const delayedMemory = {
			async recall() {
				return null
			},
			async evaluateRetain() {
				await new Promise(resolve =>
					setTimeout(resolve, 150)
				)
				return {
					parts: [
						{
							type: 'memory-retain',
							factsStored: 1,
							facts: ['retained after first turn'],
							duration_ms: 150
						}
					],
					trigger: 'turn_count',
					bankIds: ['bank-1'],
					seqFrom: 1,
					seqTo: 2,
					timestamp: Date.now()
				}
			}
		} as unknown as MemoryOrchestrator

		const memoryController = new AgentController(store, {
			adapter: createMockAdapter(),
			workspaceDir,
			dataDir: tmpDir,
			memory: delayedMemory
		})

		try {
			await memoryController.handleMessage(
				'session-1',
				'First',
				firstUserRow.id
			)
			for (let attempt = 0; attempt < 20; attempt++) {
				const closedRuns = eventStore.query({
					sessionId: 'session-1',
					types: ['run_closed']
				})
				if (closedRuns.length > 0) break
				await new Promise(resolve =>
					setTimeout(resolve, 10)
				)
			}

			const secondUserRow = store.appendEvent(
				'session-1',
				'user_message',
				{
					role: 'user',
					content: [{ type: 'text', text: 'Second' }],
					timestamp: Date.now()
				}
			)

			let secondSettled = false
			const secondRun = memoryController
				.handleMessage(
					'session-1',
					'Second',
					secondUserRow.id
				)
				.then(result => {
					secondSettled = true
					return result
				})

			await new Promise(resolve => setTimeout(resolve, 50))
			expect(secondSettled).toBe(false)

			const secondResult = await secondRun
			await new Promise(resolve => setTimeout(resolve, 250))

			const events = eventStore.query({
				sessionId: 'session-1'
			})
			const retainEvent = events.find(
				event => event.type === 'memory_retain'
			)
			const secondRunStart = events.find(
				event =>
					event.type === 'agent_start' &&
					event.runId === secondResult.runId
			)

			expect(retainEvent).toBeDefined()
			expect(retainEvent!.runId).toBeNull()
			expect(secondRunStart).toBeDefined()
			expect(retainEvent!.seq).toBeLessThan(
				secondRunStart!.seq
			)
		} finally {
		}
	})

	test('controller works normally without memory orchestrator', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		// No memory option
		const { routed } = await controller.handleMessage(
			'session-1',
			'Hello'
		)
		expect(routed).toBe('prompt')

		await new Promise(r => setTimeout(r, 500))

		const events = eventStore.query({
			sessionId: 'session-1'
		})
		const types = events.map(e => e.type)

		// No memory events when no orchestrator
		expect(types).not.toContain('memory_recall')
		expect(types).not.toContain('memory_retain')
		expect(types).toContain('agent_start')
		expect(types).toContain('run_closed')
	})

	test('guardrail diagnostics stay out of the durable session DB', async () => {
		store.ensureSession('session-1')
		store.appendEvent('session-1', 'user_message', {
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
			timestamp: Date.now()
		})

		// Use a slow adapter so the agent is still streaming when we queue
		// a follow-up. With maxModelCalls=1 and > semantics, the first call
		// (modelCallCount=1) completes normally; the pre-call checkpoint for
		// the second call (modelCallCount=2, 2 > 1) triggers limit_hit.
		const guardedController = new AgentController(store, {
			adapter: createMockAdapter(undefined, 50),
			workspaceDir,
			dataDir: tmpDir,
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

			// Queue a follow-up while the agent is still streaming, so
			// the loop has a reason to continue and hit the limit.
			await new Promise(r => setTimeout(r, 100))
			store.appendEvent('session-1', 'user_message', {
				role: 'user',
				content: [{ type: 'text', text: 'Follow-up' }],
				timestamp: Date.now()
			})
			await guardedController.handleMessage(
				'session-1',
				'Follow-up'
			)

			await new Promise(r => setTimeout(r, 1500))

			const events = eventStore.query({
				sessionId: 'session-1'
			})
			const types = events.map(e => e.type)

			expect(types).toContain('agent_start')
			expect(types).toContain('run_closed')
			expect(types).not.toContain('limit_hit')
		} finally {
		}
	})
})
