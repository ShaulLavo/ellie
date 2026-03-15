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

function makeUsage() {
	return {
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
	}
}

function makeAssistantMessage(
	text: string,
	stopReason: string = 'stop'
) {
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		provider: 'anthropic',
		model: 'test',
		usage: makeUsage(),
		stopReason,
		timestamp: Date.now()
	}
}

describe('stream-persistence artifact emission', () => {
	let tmpDir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let state: StreamState
	let deps: StreamPersistenceDeps
	const branchId = 'test-branch'
	const runId = 'test-run'

	beforeEach(() => {
		tmpDir = createTempDir()
		eventStore = new EventStore(join(tmpDir, 'events.db'))
		const thread = eventStore.createThread(
			'agent-test',
			'test',
			'ws-test'
		)
		eventStore.createBranch(
			thread.id,
			undefined,
			undefined,
			undefined,
			branchId
		)
		store = new RealtimeStore(eventStore)
		state = createStreamState()
		deps = {
			store,
			trace: () => {}
		}
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('emits assistant_artifact events instead of injecting MEDIA directives', () => {
		// 1. Tool-use assistant message
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					"I'll generate that image for you.",
					'toolUse'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: makeAssistantMessage(
					"I'll generate that image for you.",
					'toolUse'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		// 2. Tool execution
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_start',
				toolCallId: 'tc-1',
				toolName: 'generate_image',
				args: { prompt: 'a cat' }
			} as AgentEvent,
			branchId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_end',
				toolCallId: 'tc-1',
				toolName: 'generate_image',
				result: {
					content: [
						{ type: 'text', text: 'Image generated.' }
					],
					details: {
						success: true,
						uploadId: 'trace/test-run/image-gen/abc123.png'
					}
				},
				isError: false,
				elapsedMs: 5000
			} as AgentEvent,
			branchId,
			runId
		)

		// Upload tracked as pending artifact
		expect(state.pendingArtifacts).toHaveLength(1)
		expect(state.pendingArtifacts[0]!.uploadId).toBe(
			'trace/test-run/image-gen/abc123.png'
		)

		// 3. Next assistant message receives the artifact
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					'Here is your generated image.'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: makeAssistantMessage(
					'Here is your generated image.'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		// Pending artifacts cleared
		expect(state.pendingArtifacts).toHaveLength(0)

		// Verify: assistant message text is CLEAN (no MEDIA: lines)
		const rows = store.queryRunEvents(branchId, runId)
		const assistantRows = rows.filter(
			r => r.type === 'assistant_message'
		)
		expect(assistantRows).toHaveLength(2)

		const secondPayload = JSON.parse(
			assistantRows[1]!.payload
		)
		const secondText = secondPayload.message.content.find(
			(c: { type: string }) => c.type === 'text'
		)
		expect(secondText.text).toBe(
			'Here is your generated image.'
		)
		expect(secondText.text).not.toContain('MEDIA:')

		// Verify: assistant_artifact event was emitted
		const artifactRows = rows.filter(
			r => r.type === 'assistant_artifact'
		)
		expect(artifactRows).toHaveLength(1)
		const artifactPayload = JSON.parse(
			artifactRows[0]!.payload
		)
		expect(artifactPayload.kind).toBe('media')
		expect(artifactPayload.origin).toBe('tool_upload')
		expect(artifactPayload.uploadId).toBe(
			'trace/test-run/image-gen/abc123.png'
		)
		expect(artifactPayload.assistantRowId).toBe(
			assistantRows[1]!.id
		)
	})

	test('tracks upload even when tool_execution_start has no DB row', () => {
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					'Generating...',
					'toolUse'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		// Skip tool_execution_start — directly end
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
			branchId,
			runId
		)

		expect(state.pendingArtifacts).toHaveLength(1)
		expect(state.pendingArtifacts[0]!.uploadId).toBe(
			'trace/run/orphan.png'
		)
	})

	test('tracks uploads from any tool with uploadId', () => {
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					'Processing...',
					'toolUse'
				)
			} as AgentEvent,
			branchId,
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
			branchId,
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
			branchId,
			runId
		)

		expect(state.pendingArtifacts).toHaveLength(1)
		expect(state.pendingArtifacts[0]!.uploadId).toBe(
			'trace/run/output.pdf'
		)
	})

	test('sequential tool uploads emit artifact events per reply', () => {
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
					message: makeAssistantMessage(
						reply.text,
						reply.stopReason
					)
				} as AgentEvent,
				branchId,
				runId
			)

			handleStreamingEvent(
				deps,
				state,
				{
					type: 'message_end',
					message: makeAssistantMessage(
						reply.text,
						reply.stopReason
					)
				} as AgentEvent,
				branchId,
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
					branchId,
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
					branchId,
					runId
				)
			}
		}

		const rows = store.queryRunEvents(branchId, runId)
		const assistantRows = rows.filter(
			r => r.type === 'assistant_message'
		)
		expect(assistantRows).toHaveLength(4)

		// All assistant message texts should be CLEAN
		for (const row of assistantRows) {
			const payload = JSON.parse(row.payload)
			const textPart = payload.message.content.find(
				(c: { type: string }) => c.type === 'text'
			)
			expect(textPart.text).not.toContain('MEDIA:')
		}

		// Check artifact events
		const artifactRows = rows.filter(
			r => r.type === 'assistant_artifact'
		)
		// Reply 1 (index 0) has no artifacts (no tool runs before it)
		// Reply 2 (index 1) gets img-1.png (1 artifact)
		// Reply 3 (index 2) gets img-2a, img-2b, img-2c (3 artifacts)
		// Reply 4 (index 3) gets img-3a, img-3b (2 artifacts)
		expect(artifactRows).toHaveLength(6)

		// Verify artifact targeting
		const artifactsForReply2 = artifactRows.filter(r => {
			const p = JSON.parse(r.payload)
			return p.assistantRowId === assistantRows[1]!.id
		})
		expect(artifactsForReply2).toHaveLength(1)

		const artifactsForReply3 = artifactRows.filter(r => {
			const p = JSON.parse(r.payload)
			return p.assistantRowId === assistantRows[2]!.id
		})
		expect(artifactsForReply3).toHaveLength(3)

		const artifactsForReply4 = artifactRows.filter(r => {
			const p = JSON.parse(r.payload)
			return p.assistantRowId === assistantRows[3]!.id
		})
		expect(artifactsForReply4).toHaveLength(2)

		expect(state.pendingArtifacts).toHaveLength(0)
	})

	test('strips [[tts:...]] and sets ttsDirective on message_end', () => {
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					'Hello! [[tts:voiceId=abc speed=1.2]]'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: makeAssistantMessage(
					'Hello! [[tts:voiceId=abc speed=1.2]]'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		const rows = store.queryRunEvents(branchId, runId)
		const assistantRow = rows.find(
			r => r.type === 'assistant_message'
		)!
		const payload = JSON.parse(assistantRow.payload)

		// Text should be clean
		expect(payload.message.content[0].text).toBe('Hello!')
		// ttsDirective should be set
		expect(payload.ttsDirective).toBeDefined()
		expect(payload.ttsDirective.params).toBe(
			'voiceId=abc speed=1.2'
		)
	})

	test('sets sourceAssistantRowId on tool_execution_start', () => {
		// First assistant message
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_start',
				message: makeAssistantMessage(
					'Calling tool...',
					'toolUse'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		handleStreamingEvent(
			deps,
			state,
			{
				type: 'message_end',
				message: makeAssistantMessage(
					'Calling tool...',
					'toolUse'
				)
			} as AgentEvent,
			branchId,
			runId
		)

		// Now tool starts — should have sourceAssistantRowId
		handleStreamingEvent(
			deps,
			state,
			{
				type: 'tool_execution_start',
				toolCallId: 'tc-1',
				toolName: 'test_tool',
				args: {}
			} as AgentEvent,
			branchId,
			runId
		)

		const rows = store.queryRunEvents(branchId, runId)
		const toolRow = rows.find(
			r => r.type === 'tool_execution'
		)!
		const assistantRow = rows.find(
			r => r.type === 'assistant_message'
		)!
		const toolPayload = JSON.parse(toolRow.payload)

		expect(toolPayload.sourceAssistantRowId).toBe(
			assistantRow.id
		)
	})
})
