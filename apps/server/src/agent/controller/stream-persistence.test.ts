import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import {
	handleStreamingEvent,
	createStreamState,
	type StreamState,
	type StreamPersistenceDeps
} from './stream-persistence'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../../lib/realtime-store'
import type { AgentEvent } from '@ellie/agent'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'stream-persist-test-'))
}

describe('stream-persistence image-gen injection', () => {
	let tmpDir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let state: StreamState
	let deps: StreamPersistenceDeps
	const sessionId = 'test-session'
	const runId = 'test-run'

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
		store = new RealtimeStore(eventStore, sessionId)
		state = createStreamState()
		deps = {
			store,
			trace: () => {}
		}
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('injects MEDIA directive into the next assistant message after generate_image', () => {
		// 1. Tool-use assistant message starts
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: "I'll generate that image for you."
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
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		expect(state.currentMessageRowId).not.toBeNull()

		// 2. Tool-use assistant message ends before the tool runs
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: "I'll generate that image for you."
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
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		// 3. tool_execution_start for generate_image
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_start',
				toolCallId: 'tc-1',
				toolName: 'generate_image',
				args: { prompt: 'a cat' }
			} as AgentEvent,
			sessionId,
			runId
		)

		expect(state.currentToolRowIds.has('tc-1')).toBe(true)

		// 4. tool_execution_end for generate_image (success)
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_end',
				toolCallId: 'tc-1',
				toolName: 'generate_image',
				result: {
					content: [
						{
							type: 'text',
							text: 'Image generated successfully.'
						}
					],
					details: {
						success: true,
						uploadId:
							'trace/test-run/image-gen/generated_image/abc123.png',
						url: '/api/uploads-rpc/trace%2Ftest-run%2Fimage-gen%2Fgenerated_image%2Fabc123.png/content'
					}
				},
				isError: false,
				elapsedMs: 5000
			} as AgentEvent,
			sessionId,
			runId
		)

		// Upload should be tracked
		expect(state.pendingToolUploads).toEqual([
			'trace/test-run/image-gen/generated_image/abc123.png'
		])

		// 5. Next assistant message starts after the tool result
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Here is your generated image.'
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
					stopReason: 'stop',
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		// 6. Final assistant message receives the MEDIA directive
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Here is your generated image.'
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
					stopReason: 'stop',
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		// pendingToolUploads should be cleared
		expect(state.pendingToolUploads).toEqual([])

		// Verify the follow-up assistant message has the injected MEDIA directive
		const rows = store.queryRunEvents(sessionId, runId)
		const assistantRows = rows.filter(
			r => r.type === 'assistant_message'
		)
		expect(assistantRows).toHaveLength(2)

		const firstPayload = JSON.parse(
			assistantRows[0]!.payload
		)
		const secondPayload = JSON.parse(
			assistantRows[1]!.payload
		)
		const firstText = firstPayload.message.content.find(
			(c: { type: string }) => c.type === 'text'
		)
		const secondText = secondPayload.message.content.find(
			(c: { type: string }) => c.type === 'text'
		)
		expect(firstText.text).toBe(
			"I'll generate that image for you."
		)
		expect(firstText.text).not.toContain('MEDIA:')
		expect(secondText.text).toContain(
			'Here is your generated image.'
		)
		expect(secondText.text).toContain('MEDIA:')
		expect(secondText.text).toContain('/api/uploads-rpc/')
		expect(secondText.text).toContain('abc123.png')
	})

	test('tracks upload even when tool_execution_start has no DB row', () => {
		// 1. message_start for assistant message
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Generating...' }
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
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		// 2. Skip tool_execution_start (simulating missing start event)
		// 3. tool_execution_end without a matching start — upload should STILL be tracked
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_end',
				toolCallId: 'tc-orphan',
				toolName: 'generate_image',
				result: {
					content: [
						{ type: 'text', text: 'Image generated.' }
					],
					details: {
						success: true,
						uploadId: 'trace/run/orphan.png'
					}
				},
				isError: false,
				elapsedMs: 3000
			} as AgentEvent,
			sessionId,
			runId
		)

		// Upload IS tracked even without matching start row
		expect(state.pendingToolUploads).toEqual([
			'trace/run/orphan.png'
		])
	})

	test('tracks uploads from any tool with uploadId (not just generate_image)', () => {
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Processing...' }
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
					timestamp: Date.now()
				}
			} as AgentEvent,
			sessionId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_start',
				toolCallId: 'tc-1',
				toolName: 'some_other_tool',
				args: {}
			} as AgentEvent,
			sessionId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_end',
				toolCallId: 'tc-1',
				toolName: 'some_other_tool',
				result: {
					content: [{ type: 'text', text: 'Done' }],
					details: {
						success: true,
						uploadId: 'trace/run/output.pdf'
					}
				},
				isError: false,
				elapsedMs: 1000
			} as AgentEvent,
			sessionId,
			runId
		)

		expect(state.pendingToolUploads).toEqual([
			'trace/run/output.pdf'
		])
	})

	test('sequential tool uploads attach to each subsequent assistant message', () => {
		const assistantReplies = [
			{
				text: 'Sure! I will make imgs one by one.',
				stopReason: 'toolUse'
			},
			{
				text: 'Here you go!',
				stopReason: 'toolUse'
			},
			{
				text: 'Made img 2',
				stopReason: 'toolUse'
			},
			{
				text: 'Made img 3',
				stopReason: 'stop'
			}
		] as const
		const uploadsAfterReply = [
			['trace/run/img-1.png'],
			[
				'trace/run/img-2a.png',
				'trace/run/img-2b.png',
				'trace/run/img-2c.png'
			],
			['trace/run/img-3a.png', 'trace/run/img-3b.png']
		]

		for (const [
			index,
			reply
		] of assistantReplies.entries()) {
			handleStreamingEvent(
				deps,
				state,
				{
					type: 'message_start',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: reply.text }],
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
						stopReason: reply.stopReason,
						timestamp: Date.now()
					}
				} as AgentEvent,
				sessionId,
				runId
			)

			handleStreamingEvent(
				deps,
				state,
				{
					type: 'message_end',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: reply.text }],
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
						stopReason: reply.stopReason,
						timestamp: Date.now()
					}
				} as AgentEvent,
				sessionId,
				runId
			)

			if (index === uploadsAfterReply.length) continue

			for (const [
				uploadIndex,
				uploadId
			] of uploadsAfterReply[index].entries()) {
				const toolCallId = `tc-${index + 1}-${uploadIndex + 1}`
				handleStreamingEvent(
					deps,
					state,
					{
						type: 'tool_execution_start',
						toolCallId,
						toolName: 'generate_image',
						args: {}
					} as AgentEvent,
					sessionId,
					runId
				)

				handleStreamingEvent(
					deps,
					state,
					{
						type: 'tool_execution_end',
						toolCallId,
						toolName: 'generate_image',
						result: {
							content: [{ type: 'text', text: 'Done' }],
							details: {
								success: true,
								uploadId
							}
						},
						isError: false,
						elapsedMs: 2000
					} as AgentEvent,
					sessionId,
					runId
				)
			}
		}

		const rows = store.queryRunEvents(sessionId, runId)
		const assistantRows = rows.filter(
			r => r.type === 'assistant_message'
		)
		expect(assistantRows).toHaveLength(4)

		const texts = assistantRows.map(row => {
			const payload = JSON.parse(row.payload)
			const textPart = payload.message.content.find(
				(c: { type: string }) => c.type === 'text'
			)
			return textPart.text as string
		})

		expect(texts[0]).toBe(
			'Sure! I will make imgs one by one.'
		)
		expect(texts[0]).not.toContain('MEDIA:')
		expect(texts[1]).toContain('Here you go!')
		expect(texts[1]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-1.png/content'
		)
		expect(texts[2]).toContain('Made img 2')
		expect(texts[2]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-2a.png/content'
		)
		expect(texts[2]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-2b.png/content'
		)
		expect(texts[2]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-2c.png/content'
		)
		expect(texts[3]).toContain('Made img 3')
		expect(texts[3]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-3a.png/content'
		)
		expect(texts[3]).toContain(
			'/api/uploads-rpc/trace%2Frun%2Fimg-3b.png/content'
		)
		expect(state.pendingToolUploads).toHaveLength(0)
	})
})
