import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@ellie/agent'
import {
	TraceRecorder,
	createRootScope
} from '@ellie/trace'
import { hindsightTraceStore } from '@ellie/hindsight'
import type { RealtimeStore } from '../../lib/realtime-store'
import type { MemoryOrchestrator } from '../memory-orchestrator'
import { runRecall } from './memory'

describe('runRecall tracing', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('records exact hindsight chat payloads on a stable child span', async () => {
		const traceDir = mkdtempSync(
			join(tmpdir(), 'memory-trace-test-')
		)
		tempDirs.push(traceDir)

		const recorder = new TraceRecorder(traceDir)
		const scope = createRootScope({
			traceKind: 'chat',
			sessionId: 'session-1',
			runId: 'run-1'
		})
		const deps = {
			store: {} as RealtimeStore,
			memory: {
				async recall(query: string) {
					const ctx = hindsightTraceStore.getStore()
					ctx?.onLLMCall({
						phase: 'start',
						callId: 'call-1',
						startedAt: 123,
						messageCount: 1,
						systemPromptCount: 1,
						hasTools: true,
						messages: [
							{
								role: 'user',
								content: `query:${query}`
							}
						],
						systemPrompts: ['system prompt'],
						tools: [
							{
								name: 'search_memories',
								parameters: { type: 'object' }
							}
						],
						modelOptions: {
							response_format: {
								type: 'json_object'
							}
						}
					})
					ctx?.onLLMCall({
						phase: 'end',
						callId: 'call-1',
						startedAt: 123,
						elapsedMs: 5,
						responseLength: 6,
						responseText: 'answer',
						toolCalls: [
							{
								toolCallId: 'tool-1',
								toolName: 'search_memories',
								argsJson: '{"query":"alpha"}'
							}
						]
					})
					return {
						payload: {
							parts: [
								{
									type: 'memory',
									text: 'Recalled 1 memory',
									count: 1,
									memories: [{ text: 'alpha memory' }],
									duration_ms: 5
								}
							],
							query,
							bankIds: ['bank-1'],
							searchResults: [],
							timestamp: Date.now()
						},
						contextBlock:
							'<recalled_memories>\n  1. alpha memory\n</recalled_memories>'
					}
				},
				async evaluateRetain() {
					return null
				}
			} as unknown as MemoryOrchestrator,
			agent: {
				state: {
					systemPrompt: 'base prompt'
				}
			} as unknown as Agent,
			baseSystemPrompt: 'base prompt',
			trace: () => {},
			traceRecorder: recorder,
			traceScope: scope
		}

		await runRecall(deps, 'session-1', 'alpha', 'run-1')

		const events = recorder.readTrace(scope.traceId)
		const start = events.find(
			event => event.kind === 'memory.chat.start'
		)
		const end = events.find(
			event => event.kind === 'memory.chat.end'
		)

		expect(start).toBeDefined()
		expect(end).toBeDefined()
		expect(start!.spanId).toBe(end!.spanId)
		expect(start!.payload).toMatchObject({
			callId: 'call-1',
			messages: [{ role: 'user', content: 'query:alpha' }],
			systemPrompts: ['system prompt'],
			tools: [
				{
					name: 'search_memories',
					parameters: { type: 'object' }
				}
			]
		})
		expect(end!.payload).toMatchObject({
			callId: 'call-1',
			responseText: 'answer',
			toolCalls: [
				{
					toolCallId: 'tool-1',
					toolName: 'search_memories',
					argsJson: '{"query":"alpha"}'
				}
			]
		})
		expect(
			(
				deps.agent as unknown as {
					state: { systemPrompt: string }
				}
			).state.systemPrompt
		).toContain('alpha memory')
	})
})
