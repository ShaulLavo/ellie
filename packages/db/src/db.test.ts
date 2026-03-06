import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { EventStore } from './event-store'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

// ════════════════════════════════════════════════════════════════════════════
// EventStore
// ════════════════════════════════════════════════════════════════════════════

describe('EventStore', () => {
	let tmpDir: string
	let dbPath: string
	let store: EventStore

	beforeEach(() => {
		tmpDir = makeTempDir('ellie-eventstore-')
		dbPath = join(tmpDir, 'test.db')
		store = new EventStore(dbPath)
	})

	afterEach(() => {
		store.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	// ── Session CRUD ────────────────────────────────────────────────────────

	describe('session CRUD', () => {
		it('creates a session with auto-generated ID', () => {
			const session = store.createSession()
			expect(session.id).toBeDefined()
			expect(session.id.length).toBeGreaterThan(0)
			expect(session.currentSeq).toBe(0)
			expect(session.createdAt).toBeGreaterThan(0)
			expect(session.updatedAt).toBeGreaterThan(0)
		})

		it('creates a session with explicit ID', () => {
			const session = store.createSession('my-session')
			expect(session.id).toBe('my-session')
		})

		it('gets a session', () => {
			store.createSession('s1')
			const session = store.getSession('s1')
			expect(session).toBeDefined()
			expect(session!.id).toBe('s1')
		})

		it('returns undefined for non-existent session', () => {
			expect(store.getSession('nope')).toBeUndefined()
		})

		it('lists sessions', () => {
			store.createSession('a')
			store.createSession('b')
			store.createSession('c')
			const sessions = store.listSessions()
			expect(sessions).toHaveLength(3)
		})

		it('deletes a session', () => {
			store.createSession('del')
			store.deleteSession('del')
			expect(store.getSession('del')).toBeUndefined()
		})
	})

	// ── Cascade delete ────────────────────────────────────────────────────

	describe('cascade delete', () => {
		it('deleting session cascades to events', () => {
			store.createSession('cascade')
			store.append({
				sessionId: 'cascade',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: Date.now()
				}
			})

			expect(
				store.query({ sessionId: 'cascade' })
			).toHaveLength(1)

			store.deleteSession('cascade')
			expect(
				store.query({ sessionId: 'cascade' })
			).toHaveLength(0)
		})
	})

	// ── Event append ──────────────────────────────────────────────────────

	describe('append', () => {
		beforeEach(() => {
			store.createSession('s1')
		})

		it('appends an event and returns event row', () => {
			const row = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: Date.now()
				}
			})

			expect(row.id).toBeGreaterThan(0)
			expect(row.sessionId).toBe('s1')
			expect(row.seq).toBe(1)
			expect(row.type).toBe('user_message')
		})

		it('monotonically increments seq per session', () => {
			const r1 = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'a' }],
					timestamp: Date.now()
				}
			})
			const r2 = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'b' }],
					timestamp: Date.now()
				}
			})
			const r3 = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'c' }],
					timestamp: Date.now()
				}
			})

			expect(r1.seq).toBe(1)
			expect(r2.seq).toBe(2)
			expect(r3.seq).toBe(3)
		})

		it('updates updatedAt on append', async () => {
			const before = store.getSession('s1')!.updatedAt
			await Bun.sleep(10) // Ensure timestamp advances past same-millisecond edge case
			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'x' }],
					timestamp: Date.now()
				}
			})
			const after = store.getSession('s1')!.updatedAt
			expect(after).toBeGreaterThan(before)
		})

		it('throws for non-existent session', () => {
			expect(() =>
				store.append({
					sessionId: 'nope',
					type: 'user_message',
					payload: {
						role: 'user',
						content: [{ type: 'text', text: 'x' }],
						timestamp: Date.now()
					}
				})
			).toThrow('Session not found')
		})
	})

	// ── Dedupe ────────────────────────────────────────────────────────────

	describe('dedupe', () => {
		beforeEach(() => {
			store.createSession('s1')
		})

		it('returns existing event for duplicate dedupeKey', () => {
			const r1 = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: Date.now()
				},
				dedupeKey: 'msg-1'
			})
			const r2 = store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'different' }],
					timestamp: Date.now()
				},
				dedupeKey: 'msg-1'
			})

			expect(r1.id).toBe(r2.id)
			expect(r1.seq).toBe(r2.seq)
			expect(store.query({ sessionId: 's1' })).toHaveLength(
				1
			)
		})

		it('different dedupeKeys create separate events', () => {
			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'a' }],
					timestamp: Date.now()
				},
				dedupeKey: 'msg-1'
			})
			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'b' }],
					timestamp: Date.now()
				},
				dedupeKey: 'msg-2'
			})

			expect(store.query({ sessionId: 's1' })).toHaveLength(
				2
			)
		})
	})

	// ── Payload validation ────────────────────────────────────────────────

	describe('payload validation', () => {
		beforeEach(() => {
			store.createSession('s1')
		})

		it('rejects invalid payload for user_message', () => {
			expect(() =>
				store.append({
					sessionId: 's1',
					type: 'user_message',
					payload: {
						role: 'invalid',
						content: 'not-an-array'
					} as any
				})
			).toThrow()
		})

		it('accepts valid agent_start payload', () => {
			expect(() =>
				store.append({
					sessionId: 's1',
					type: 'agent_start',
					payload: {}
				})
			).not.toThrow()
		})

		it('accepts valid run_closed payload', () => {
			expect(() =>
				store.append({
					sessionId: 's1',
					type: 'run_closed',
					payload: { reason: 'completed' }
				})
			).not.toThrow()
		})

		it('accepts valid error payload', () => {
			expect(() =>
				store.append({
					sessionId: 's1',
					type: 'error',
					payload: { message: 'something went wrong' }
				})
			).not.toThrow()
		})
	})

	// ── Query ─────────────────────────────────────────────────────────────

	describe('query', () => {
		beforeEach(() => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: 1000
				},
				runId: 'run-1'
			})
			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {},
				runId: 'run-1'
			})
			store.append({
				sessionId: 's1',
				type: 'assistant_message',
				payload: {
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'hi' }],
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
						timestamp: 2000
					},
					streaming: false
				},
				runId: 'run-1'
			})
			store.append({
				sessionId: 's1',
				type: 'run_closed',
				payload: { reason: 'completed' },
				runId: 'run-1'
			})
		})

		it('returns all events for a session', () => {
			const events = store.query({ sessionId: 's1' })
			expect(events).toHaveLength(4)
		})

		it('filters by afterSeq', () => {
			const events = store.query({
				sessionId: 's1',
				afterSeq: 2
			})
			expect(events).toHaveLength(2)
			expect(events[0]!.seq).toBe(3)
			expect(events[1]!.seq).toBe(4)
		})

		it('filters by types', () => {
			const events = store.query({
				sessionId: 's1',
				types: ['user_message', 'assistant_message']
			})
			expect(events).toHaveLength(2)
		})

		it('filters by runId', () => {
			store.createSession('s2')
			store.append({
				sessionId: 's2',
				type: 'agent_start',
				payload: {},
				runId: 'other-run'
			})

			const events = store.query({
				sessionId: 's1',
				runId: 'run-1'
			})
			expect(events).toHaveLength(4)
		})

		it('respects limit', () => {
			const events = store.query({
				sessionId: 's1',
				limit: 2
			})
			expect(events).toHaveLength(2)
			expect(events[0]!.seq).toBe(1)
			expect(events[1]!.seq).toBe(2)
		})
	})

	// ── assistant_delta absent in DB ──────────────────────────────────────

	describe('assistant_delta not persisted', () => {
		it('assistant_delta is not a valid event type', () => {
			store.createSession('s1')
			expect(() =>
				store.append({
					sessionId: 's1',
					type: 'assistant_delta' as never,
					payload: { delta: 'some text' } as never
				})
			).toThrow()
		})
	})

	// ── History reconstruction ────────────────────────────────────────────

	describe('getConversationHistory', () => {
		it('builds history from user_message, assistant_message, tool_execution', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: 1000
				}
			})
			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {}
			})
			store.append({
				sessionId: 's1',
				type: 'assistant_message',
				payload: {
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: "I'll help" },
							{
								type: 'toolCall',
								id: 'tc1',
								name: 'search',
								arguments: { q: 'test' }
							}
						],
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
						stopReason: 'toolUse',
						timestamp: 2000
					},
					streaming: false
				}
			})
			store.append({
				sessionId: 's1',
				type: 'tool_execution',
				payload: {
					toolCallId: 'tc1',
					toolName: 'search',
					args: { q: 'test' },
					result: {
						content: [
							{ type: 'text', text: 'result data' }
						],
						details: {}
					},
					isError: false,
					status: 'complete'
				}
			})
			store.append({
				sessionId: 's1',
				type: 'assistant_message',
				payload: {
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'Here are the results' }
						],
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
						timestamp: 4000
					},
					streaming: false
				}
			})
			store.append({
				sessionId: 's1',
				type: 'agent_end',
				payload: { messages: [] }
			})

			const history = store.getConversationHistory('s1')
			expect(history).toHaveLength(4)
			expect(history[0]!.role).toBe('user')
			expect(history[1]!.role).toBe('assistant')
			expect(history[2]!.role).toBe('toolResult')
			expect(history[3]!.role).toBe('assistant')
		})

		it('excludes agent_start, agent_end, turn events from history', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {}
			})
			store.append({
				sessionId: 's1',
				type: 'turn_start',
				payload: {}
			})
			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hi' }],
					timestamp: 1000
				}
			})
			store.append({
				sessionId: 's1',
				type: 'turn_end',
				payload: {}
			})
			store.append({
				sessionId: 's1',
				type: 'agent_end',
				payload: { messages: [] }
			})

			const history = store.getConversationHistory('s1')
			expect(history).toHaveLength(1)
			expect(history[0]!.role).toBe('user')
		})
	})

	// ── Stale run recovery ────────────────────────────────────────────────

	describe('findStaleRuns', () => {
		it('finds runs with agent_start but no run_closed', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {},
				runId: 'stale-run'
			})

			const stale = store.findStaleRuns(0)
			expect(stale).toHaveLength(1)
			expect(stale[0]!.sessionId).toBe('s1')
			expect(stale[0]!.runId).toBe('stale-run')
		})

		it('does not find runs that have been closed', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {},
				runId: 'closed-run'
			})
			store.append({
				sessionId: 's1',
				type: 'run_closed',
				payload: { reason: 'completed' },
				runId: 'closed-run'
			})

			const stale = store.findStaleRuns(0)
			expect(stale).toHaveLength(0)
		})

		it('appending run_closed for recovered stale run works', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {},
				runId: 'stale-run'
			})

			const stale = store.findStaleRuns(0)
			expect(stale).toHaveLength(1)

			store.append({
				sessionId: stale[0]!.sessionId,
				type: 'run_closed',
				payload: { reason: 'recovered_after_crash' },
				runId: stale[0]!.runId
			})

			expect(store.findStaleRuns(0)).toHaveLength(0)
		})
	})

	// ── Session isolation ─────────────────────────────────────────────────

	describe('session isolation', () => {
		it('events are isolated between sessions', () => {
			store.createSession('a')
			store.createSession('b')

			store.append({
				sessionId: 'a',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'from a' }],
					timestamp: 1000
				}
			})
			store.append({
				sessionId: 'b',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'from b' }],
					timestamp: 2000
				}
			})
			store.append({
				sessionId: 'a',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'from a again' }],
					timestamp: 3000
				}
			})

			expect(store.query({ sessionId: 'a' })).toHaveLength(
				2
			)
			expect(store.query({ sessionId: 'b' })).toHaveLength(
				1
			)
		})

		it('seq is independent per session', () => {
			store.createSession('a')
			store.createSession('b')

			const ra = store.append({
				sessionId: 'a',
				type: 'agent_start',
				payload: {}
			})
			const rb = store.append({
				sessionId: 'b',
				type: 'agent_start',
				payload: {}
			})

			expect(ra.seq).toBe(1)
			expect(rb.seq).toBe(1)
		})
	})

	// ── Recovery (close/reopen) ───────────────────────────────────────────

	describe('recovery', () => {
		it('survives close and reopen', () => {
			store.createSession('persist')
			store.append({
				sessionId: 'persist',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'before' }],
					timestamp: 1000
				}
			})
			store.append({
				sessionId: 'persist',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'also before' }],
					timestamp: 2000
				}
			})
			store.close()

			store = new EventStore(dbPath)

			const events = store.query({ sessionId: 'persist' })
			expect(events).toHaveLength(2)

			const history =
				store.getConversationHistory('persist')
			expect(history).toHaveLength(2)
		})

		it('can append after reopen', () => {
			store.createSession('resume')
			store.append({
				sessionId: 'resume',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'first' }],
					timestamp: 1000
				}
			})
			store.close()

			store = new EventStore(dbPath)
			store.append({
				sessionId: 'resume',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'second' }],
					timestamp: 2000
				}
			})

			const events = store.query({ sessionId: 'resume' })
			expect(events).toHaveLength(2)
			expect(events[1]!.seq).toBe(2)
		})
	})

	// ── Performance ───────────────────────────────────────────────────────

	describe('performance', () => {
		it('appends 1,000 events', () => {
			store.createSession('bulk')

			const start = performance.now()
			for (let i = 0; i < 1_000; i++) {
				store.append({
					sessionId: 'bulk',
					type: 'user_message',
					payload: {
						role: 'user',
						content: [{ type: 'text', text: `msg ${i}` }],
						timestamp: Date.now()
					}
				})
			}
			const elapsed = performance.now() - start

			console.log(
				`[perf] 1,000 appends in ${elapsed.toFixed(0)}ms`
			)

			const events = store.query({ sessionId: 'bulk' })
			expect(events).toHaveLength(1_000)
			// No timing assertion — performance varies by environment
		})
	})

	// ── afterSeq catch-up ─────────────────────────────────────────────────

	describe('afterSeq catch-up', () => {
		it('returns only events after the given seq', () => {
			store.createSession('s1')
			for (let i = 0; i < 10; i++) {
				store.append({
					sessionId: 's1',
					type: 'user_message',
					payload: {
						role: 'user',
						content: [{ type: 'text', text: `msg ${i}` }],
						timestamp: Date.now()
					}
				})
			}

			const events = store.query({
				sessionId: 's1',
				afterSeq: 5
			})
			expect(events).toHaveLength(5)
			expect(events[0]!.seq).toBe(6)
			expect(events[4]!.seq).toBe(10)
		})

		it('afterSeq past end returns empty', () => {
			store.createSession('s1')
			store.append({
				sessionId: 's1',
				type: 'agent_start',
				payload: {}
			})

			const events = store.query({
				sessionId: 's1',
				afterSeq: 999
			})
			expect(events).toHaveLength(0)
		})
	})

	// ── No audit logging ─────────────────────────────────────────────────

	describe('no audit logging', () => {
		it('does not create an audit directory when appending events', () => {
			const auditDir = join(tmpDir, 'audit')
			const plainStore = new EventStore(
				join(tmpDir, 'no-audit-test.db')
			)

			plainStore.createSession('s1')
			plainStore.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'test' }],
					timestamp: Date.now()
				}
			})

			plainStore.close()

			expect(existsSync(auditDir)).toBe(false)
		})
	})

	// ── WAL + FK pragmas ──────────────────────────────────────────────────

	describe('pragmas', () => {
		it('uses WAL mode', () => {
			const result = store.sqlite
				.prepare('PRAGMA journal_mode')
				.get() as { journal_mode: string }
			expect(result.journal_mode).toBe('wal')
		})

		it('enables foreign keys', () => {
			const result = store.sqlite
				.prepare('PRAGMA foreign_keys')
				.get() as { foreign_keys: number }
			expect(result.foreign_keys).toBe(1)
		})
	})

	// ── Key-Value store ───────────────────────────────────────────────────

	describe('kv', () => {
		it('returns undefined for missing key', () => {
			expect(store.getKv('nope')).toBeUndefined()
		})

		it('sets and gets a value', () => {
			store.setKv('foo', 'bar')
			expect(store.getKv('foo')).toBe('bar')
		})

		it('overwrites existing value', () => {
			store.setKv('k', 'v1')
			store.setKv('k', 'v2')
			expect(store.getKv('k')).toBe('v2')
		})

		it('persists across reopen', () => {
			store.setKv('persist', 'yes')
			store.close()
			store = new EventStore(dbPath)
			expect(store.getKv('persist')).toBe('yes')
		})
	})

	// ── Guardrail events ─────────────────────────────────────────────────

	describe('limit_hit event', () => {
		it('appends and queries a limit_hit event', () => {
			const session = store.createSession()
			const payload = {
				limit: 'max_model_calls' as const,
				threshold: 50,
				observed: 50,
				usageSnapshot: {
					elapsedMs: 12345,
					modelCalls: 50,
					costUsd: 1.23
				},
				scope: 'run' as const,
				action: 'hard_stop' as const
			}

			const event = store.append({
				sessionId: session.id,
				type: 'limit_hit',
				payload,
				runId: 'run_1'
			})

			expect(event.type).toBe('limit_hit')

			const parsed = JSON.parse(event.payload)
			expect(parsed.limit).toBe('max_model_calls')
			expect(parsed.threshold).toBe(50)
			expect(parsed.observed).toBe(50)
			expect(parsed.usageSnapshot.elapsedMs).toBe(12345)
			expect(parsed.usageSnapshot.modelCalls).toBe(50)
			expect(parsed.usageSnapshot.costUsd).toBe(1.23)
			expect(parsed.scope).toBe('run')
			expect(parsed.action).toBe('hard_stop')
		})

		it('queries limit_hit by type filter', () => {
			const session = store.createSession()

			store.append({
				sessionId: session.id,
				type: 'agent_start',
				payload: {}
			})

			store.append({
				sessionId: session.id,
				type: 'limit_hit',
				payload: {
					limit: 'max_cost_usd',
					threshold: 5.0,
					observed: 5.12,
					usageSnapshot: {
						elapsedMs: 30000,
						modelCalls: 8,
						costUsd: 5.12
					},
					scope: 'run',
					action: 'hard_stop'
				}
			})

			const results = store.query({
				sessionId: session.id,
				types: ['limit_hit']
			})

			expect(results.length).toBe(1)
			expect(results[0]!.type).toBe('limit_hit')
		})

		it('rejects invalid limit_hit payload', () => {
			const session = store.createSession()

			expect(() =>
				store.append({
					sessionId: session.id,
					type: 'limit_hit',
					// Deliberately invalid — testing runtime validation
					payload: {
						limit: 'invalid_limit' as never,
						threshold: 50,
						observed: 50
					} as never
				})
			).toThrow()
		})
	})

	// ── Memory events ───────────────────────────────────────────────────

	describe('memory_recall event', () => {
		it('appends and queries a memory_recall event', () => {
			const session = store.createSession()
			const payload = {
				parts: [
					{
						type: 'memory' as const,
						text: 'Recalled 3 memories',
						count: 3,
						memories: [
							{ text: 'User prefers dark mode' },
							{
								text: 'Project uses TypeScript',
								model: 'test'
							},
							{ text: 'Bun is the runtime' }
						],
						duration_ms: 150
					}
				],
				query: 'What are the project preferences?',
				bankIds: ['bank-1', 'bank-2'],
				timestamp: Date.now()
			}

			const event = store.append({
				sessionId: session.id,
				type: 'memory_recall',
				payload,
				runId: 'run_1'
			})

			expect(event.type).toBe('memory_recall')

			const parsed = JSON.parse(event.payload)
			expect(parsed.parts[0].type).toBe('memory')
			expect(parsed.parts[0].count).toBe(3)
			expect(parsed.parts[0].memories).toHaveLength(3)
			expect(parsed.query).toBe(
				'What are the project preferences?'
			)
			expect(parsed.bankIds).toEqual(['bank-1', 'bank-2'])
		})

		it('queries memory_recall by type filter', () => {
			const session = store.createSession()
			store.append({
				sessionId: session.id,
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hi' }],
					timestamp: Date.now()
				}
			})
			store.append({
				sessionId: session.id,
				type: 'memory_recall',
				payload: {
					parts: [
						{
							type: 'memory',
							text: 'No memories',
							count: 0
						}
					],
					query: 'hi',
					bankIds: [],
					timestamp: Date.now()
				}
			})

			const results = store.query({
				sessionId: session.id,
				types: ['memory_recall']
			})
			expect(results).toHaveLength(1)
			expect(results[0]!.type).toBe('memory_recall')
		})

		it('rejects invalid memory_recall payload', () => {
			const session = store.createSession()
			expect(() =>
				store.append({
					sessionId: session.id,
					type: 'memory_recall',
					payload: {
						parts: 'not-an-array',
						query: 123
					} as any
				})
			).toThrow()
		})
	})

	describe('memory_retain event', () => {
		it('appends and queries a memory_retain event', () => {
			const session = store.createSession()
			const payload = {
				parts: [
					{
						type: 'memory-retain' as const,
						factsStored: 4,
						facts: [
							'User likes dark mode',
							'Project uses Bun',
							'ElysiaJS for backend',
							'React for frontend'
						],
						model: 'claude-3',
						duration_ms: 320
					}
				],
				trigger: 'turn_count' as const,
				bankIds: ['bank-1'],
				seqFrom: 1,
				seqTo: 10,
				timestamp: Date.now()
			}

			const event = store.append({
				sessionId: session.id,
				type: 'memory_retain',
				payload,
				runId: 'run_1'
			})

			expect(event.type).toBe('memory_retain')

			const parsed = JSON.parse(event.payload)
			expect(parsed.parts[0].type).toBe('memory-retain')
			expect(parsed.parts[0].factsStored).toBe(4)
			expect(parsed.parts[0].facts).toHaveLength(4)
			expect(parsed.trigger).toBe('turn_count')
			expect(parsed.seqFrom).toBe(1)
			expect(parsed.seqTo).toBe(10)
		})

		it('rejects invalid memory_retain trigger', () => {
			const session = store.createSession()
			expect(() =>
				store.append({
					sessionId: session.id,
					type: 'memory_retain',
					payload: {
						parts: [
							{
								type: 'memory-retain',
								factsStored: 1,
								facts: ['test']
							}
						],
						trigger: 'invalid_trigger',
						bankIds: [],
						seqFrom: 1,
						seqTo: 2,
						timestamp: Date.now()
					}
				})
			).toThrow()
		})
	})

	describe('getConversationHistory excludes memory events', () => {
		it('memory_recall and memory_retain are not in conversation history', () => {
			store.createSession('s1')

			store.append({
				sessionId: 's1',
				type: 'user_message',
				payload: {
					role: 'user',
					content: [{ type: 'text', text: 'hello' }],
					timestamp: 1000
				}
			})
			store.append({
				sessionId: 's1',
				type: 'memory_recall',
				payload: {
					parts: [
						{
							type: 'memory',
							text: 'Recalled 1 memory',
							count: 1
						}
					],
					query: 'hello',
					bankIds: ['bank-1'],
					timestamp: Date.now()
				}
			})
			store.append({
				sessionId: 's1',
				type: 'assistant_message',
				payload: {
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'hi' }],
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
						timestamp: 2000
					},
					streaming: false
				}
			})
			store.append({
				sessionId: 's1',
				type: 'memory_retain',
				payload: {
					parts: [
						{
							type: 'memory-retain',
							factsStored: 2,
							facts: ['fact1', 'fact2']
						}
					],
					trigger: 'turn_count',
					bankIds: ['bank-1'],
					seqFrom: 1,
					seqTo: 3,
					timestamp: Date.now()
				}
			})

			const history = store.getConversationHistory('s1')
			// Only user_message and assistant_message should be present
			expect(history).toHaveLength(2)
			expect(history[0]!.role).toBe('user')
			expect(history[1]!.role).toBe('assistant')
		})
	})
})
