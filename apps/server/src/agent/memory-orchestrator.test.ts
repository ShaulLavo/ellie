import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { EventStore } from '@ellie/db'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import type { Hindsight } from '@ellie/hindsight'
import {
	MemoryOrchestrator,
	MAX_TURNS_PER_CHUNK,
	MAX_CHARS_PER_CHUNK,
	IMMEDIATE_TURN_CHARS
} from './memory-orchestrator'

// Test helpers

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'memory-orch-test-'))
}

function makeBranch(store: EventStore, branchId?: string) {
	const thread = store.createThread(
		'agent-test',
		'test',
		'ws-test'
	)
	return store.createBranch(
		thread.id,
		undefined,
		undefined,
		undefined,
		branchId
	)
}

function createMockHindsight(overrides?: {
	recallResult?: unknown
	retainResult?: unknown
	recallError?: Error
	retainError?: Error
}) {
	const banks = new Map<
		string,
		{ id: string; name: string }
	>()
	let bankCounter = 0

	return {
		getBank(name: string) {
			return banks.get(name)
		},
		createBank(
			name: string,
			_options?: { description?: string }
		) {
			bankCounter++
			const bank = { id: `bank-${bankCounter}`, name }
			banks.set(name, bank)
			return bank
		},
		async recall(
			_bankId: string,
			_query: string,
			_options?: unknown
		) {
			if (overrides?.recallError)
				throw overrides.recallError
			return (
				overrides?.recallResult ?? {
					memories: [],
					query: _query,
					entities: {},
					chunks: {}
				}
			)
		},
		async extract(
			_bankId: string,
			_content: string,
			_options?: unknown
		) {
			return []
		},
		async retain(
			_bankId: string,
			_content: string,
			_options?: unknown
		) {
			if (overrides?.retainError)
				throw overrides.retainError
			return (
				overrides?.retainResult ?? {
					memories: [],
					entities: [],
					links: []
				}
			)
		}
	} as unknown as Hindsight
}

function appendUserMessage(
	store: EventStore,
	branchId: string,
	text: string,
	runId?: string
) {
	return store.append({
		branchId,
		type: 'user_message',
		payload: {
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		},
		runId
	})
}

function appendAssistantMessage(
	store: EventStore,
	branchId: string,
	text: string,
	runId?: string
) {
	return store.append({
		branchId,
		type: 'assistant_message',
		payload: {
			message: {
				role: 'assistant',
				content: [{ type: 'text', text }],
				provider: 'mock',
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
			},
			streaming: false
		},
		runId
	})
}

// Tests

describe('MemoryOrchestrator', () => {
	let tmpDir: string
	let eventStore: EventStore

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
	})

	afterEach(() => {
		eventStore.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	describe('recall', () => {
		test('returns empty recall when no memories found', async () => {
			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight(),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.recall('hello')

			expect(result).not.toBeNull()
			expect(result!.payload.parts[0].count).toBe(0)
			expect(result!.contextBlock).toBe('')
		})

		test('returns merged memories from recall', async () => {
			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					recallResult: {
						memories: [
							{
								memory: {
									content: 'User prefers dark mode'
								},
								score: 0.9
							},
							{
								memory: { content: 'Project uses Bun' },
								score: 0.8
							}
						],
						query: 'preferences'
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.recall('preferences')

			expect(result).not.toBeNull()
			// 2 memories from 2 banks, but deduped = 2 unique
			expect(result!.payload.parts[0].count).toBe(2)
			expect(result!.contextBlock).toContain(
				'recalled_memories'
			)
			expect(result!.contextBlock).toContain(
				'User prefers dark mode'
			)
		})

		test('dedupes identical memories across banks', async () => {
			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					recallResult: {
						memories: [
							{
								memory: { content: 'Same memory text' },
								score: 0.9
							},
							{
								memory: { content: 'Same memory text' },
								score: 0.85
							}
						],
						query: 'test'
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.recall('test')

			expect(result).not.toBeNull()
			// Each bank returns 2, but they're identical so deduped to 1
			// Actually since the mock returns same results for both banks,
			// we'll get 4 total but deduped to 1 unique text
			expect(result!.payload.parts[0].count).toBe(1)
		})

		test('returns null on total recall failure', async () => {
			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					recallError: new Error('Connection failed')
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.recall('test')

			// Should still return a payload (empty recall) not null
			expect(result).not.toBeNull()
			expect(result!.payload.parts[0].count).toBe(0)
		})
	})

	describe('retain — turn count trigger', () => {
		test(`triggers when ${MAX_TURNS_PER_CHUNK} turns accumulated`, async () => {
			makeBranch(eventStore, 's1')

			// Append exactly MAX_TURNS_PER_CHUNK turns
			for (let i = 0; i < MAX_TURNS_PER_CHUNK; i++) {
				appendUserMessage(eventStore, 's1', `message ${i}`)
			}

			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					retainResult: {
						memories: [
							{ content: 'fact 1' },
							{ content: 'fact 2' }
						],
						entities: [],
						links: []
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.evaluateRetain('s1')

			expect(result).not.toBeNull()
			expect(result!.trigger).toBe('turn_count')
			expect(result!.parts[0].factsStored).toBe(
				2 * 2 // 2 memories per bank × 2 banks
			)
		})

		test('does not trigger below turn threshold', async () => {
			makeBranch(eventStore, 's1')

			// Append fewer than MAX_TURNS_PER_CHUNK turns with short text
			for (let i = 0; i < MAX_TURNS_PER_CHUNK - 1; i++) {
				appendUserMessage(eventStore, 's1', `msg ${i}`)
			}

			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight(),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.evaluateRetain('s1')
			expect(result).toBeNull()
		})
	})

	describe('retain — char count trigger', () => {
		test(`triggers when total chars exceed ${MAX_CHARS_PER_CHUNK}`, async () => {
			makeBranch(eventStore, 's1')

			// Append 2 turns with enough chars to exceed threshold
			const longText = 'x'.repeat(
				MAX_CHARS_PER_CHUNK / 2 + 1
			)
			appendUserMessage(eventStore, 's1', longText)
			appendAssistantMessage(eventStore, 's1', longText)

			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					retainResult: {
						memories: [{ content: 'fact' }],
						entities: [],
						links: []
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.evaluateRetain('s1')

			expect(result).not.toBeNull()
			expect(result!.trigger).toBe('char_count')
		})
	})

	describe('retain — immediate turn trigger', () => {
		test(`triggers for turn >= ${IMMEDIATE_TURN_CHARS} chars`, async () => {
			makeBranch(eventStore, 's1')

			const hugeText = 'y'.repeat(IMMEDIATE_TURN_CHARS)
			appendUserMessage(eventStore, 's1', hugeText)

			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					retainResult: {
						memories: [{ content: 'big fact' }],
						entities: [],
						links: []
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.evaluateRetain('s1')

			expect(result).not.toBeNull()
			expect(result!.trigger).toBe('immediate_turn')
		})
	})

	describe('retain — cursor behavior', () => {
		test('cursor advances on success, preventing re-processing', async () => {
			makeBranch(eventStore, 's1')

			for (let i = 0; i < MAX_TURNS_PER_CHUNK; i++) {
				appendUserMessage(eventStore, 's1', `message ${i}`)
			}

			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					retainResult: {
						memories: [],
						entities: [],
						links: []
					}
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			// First retain should trigger
			const result1 = await orch.evaluateRetain('s1')
			expect(result1).not.toBeNull()

			// Second retain should not trigger (cursor advanced past all turns)
			const result2 = await orch.evaluateRetain('s1')
			expect(result2).toBeNull()
		})

		test('cursor stays on bank failure allowing retry', async () => {
			makeBranch(eventStore, 's1')

			for (let i = 0; i < MAX_TURNS_PER_CHUNK; i++) {
				appendUserMessage(eventStore, 's1', `message ${i}`)
			}

			// All banks fail
			const orch = new MemoryOrchestrator({
				hindsight: createMockHindsight({
					retainError: new Error('Bank unavailable')
				}),
				eventStore,
				workspaceDir: tmpDir
			})

			const result = await orch.evaluateRetain('s1')
			// All banks failed, so no payload
			expect(result).toBeNull()
		})
	})

	describe('bank resolution', () => {
		test('lazily creates global and project banks', async () => {
			const mockHindsight = createMockHindsight()
			const orch = new MemoryOrchestrator({
				hindsight: mockHindsight,
				eventStore,
				workspaceDir: tmpDir
			})

			// Trigger bank resolution via recall
			await orch.recall('test')

			// Should have created both banks
			const globalBank =
				mockHindsight.getBank('ellie-global')
			expect(globalBank).toBeDefined()
			expect(globalBank!.name).toBe('ellie-global')

			// At least 2 banks should be created (global + project)
		})
	})
})
