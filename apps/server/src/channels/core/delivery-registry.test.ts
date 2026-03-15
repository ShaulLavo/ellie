import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { ChannelDeliveryRegistry } from './delivery-registry'
import { EventStore } from '@ellie/db'
import type { EventPayloadMap } from '@ellie/schemas/events'
import { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelProvider } from './provider'
import type { ChannelDeliveryTarget } from './types'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync
} from 'fs'

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'delivery-test-'))
}

function createTestStores(dir: string) {
	const eventStore = new EventStore(`${dir}/events.db`)
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
		'test-branch'
	)
	const store = new RealtimeStore(eventStore)
	return { eventStore, store }
}

function makeAssistantPayload(
	text: string,
	opts?: {
		streaming?: boolean
		stopReason?: EventPayloadMap['assistant_message']['message']['stopReason']
	}
) {
	return {
		message: {
			role: 'assistant' as const,
			content: [{ type: 'text' as const, text }],
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
			stopReason: opts?.stopReason ?? 'stop',
			timestamp: Date.now()
		},
		streaming: opts?.streaming ?? false
	} satisfies EventPayloadMap['assistant_message']
}

function parseCheckpoint(row: { payload: string }) {
	return JSON.parse(row.payload) as {
		channelId: string
		accountId: string
		conversationId: string
		assistantRowId: number
		replyIndex: number
		payloadIndex: number
		attachmentIndex: number
		kind: string
		deliveredAt: number
	}
}

describe('ChannelDeliveryRegistry', () => {
	let dir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let registry: ChannelDeliveryRegistry
	let sentMessages: Array<{
		target: ChannelDeliveryTarget
		text: string
	}>
	let sentMedia: Array<{
		target: ChannelDeliveryTarget
		caption: string
		media: {
			buffer: Buffer
			mimetype: string
			fileName?: string
		}
	}>
	let sentComposing: Array<{
		target: ChannelDeliveryTarget
	}>
	let sentDeliveries: Array<
		| {
				kind: 'message'
				text: string
				target: ChannelDeliveryTarget
		  }
		| {
				kind: 'media'
				caption: string
				target: ChannelDeliveryTarget
				fileName?: string
		  }
	>

	const mockProvider: ChannelProvider = {
		id: 'test',
		displayName: 'Test',
		boot: async () => {},
		shutdown: async () => {},
		getStatus: () => ({
			state: 'disconnected' as const,
			reconnectAttempts: 0
		}),
		loginStart: async () => ({}),
		loginWait: async () => ({}),
		logout: async () => {},
		updateSettings: () => {},
		sendMessage: async (target, text) => {
			sentMessages.push({ target, text })
			sentDeliveries.push({
				kind: 'message',
				target,
				text
			})
			return {}
		},
		sendMedia: async (target, caption, media) => {
			sentMedia.push({ target, caption, media })
			sentDeliveries.push({
				kind: 'media',
				target,
				caption,
				fileName: media.fileName
			})
			return {}
		},
		sendComposing: async target => {
			sentComposing.push({ target })
		}
	}

	beforeEach(() => {
		dir = createTempDir()
		const stores = createTestStores(dir)
		eventStore = stores.eventStore
		store = stores.store
		sentMessages = []
		sentMedia = []
		sentComposing = []
		sentDeliveries = []

		registry = new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				id === 'test' ? mockProvider : undefined,
			dataDir: dir
		})
	})

	afterEach(() => {
		registry.shutdown()
		rmSync(dir, { recursive: true, force: true })
	})

	test('register stores pending delivery', () => {
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}
		registry.register('run-1', 'test-branch', target)
		// No error means it stored successfully
	})

	test('run_closed triggers sendMessage with final assistant text', async () => {
		const branchId = 'test-branch'
		const runId = 'run-1'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}

		// Register delivery
		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		// Persist an assistant_message for this run
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Hello from Ellie!'),
			runId
		)

		// Emit run_closed
		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Wait for async delivery
		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Hello from Ellie!')
		expect(sentMessages[0].target).toEqual(target)
	})

	test('flushes a finalized assistant update before run_closed', async () => {
		const branchId = 'test-branch'
		const runId = 'run-live-final'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-live-final'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		const row = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Still thinking...', {
				streaming: true,
				stopReason: 'toolUse'
			}),
			runId
		)

		store.updateEvent(
			row.id,
			makeAssistantPayload(
				'Here is the finalized message.'
			),
			branchId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe(
			'Here is the finalized message.'
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 100))

		expect(sentMessages).toHaveLength(1)
	})

	test('flushes text immediately, then sends the later image reply once', async () => {
		const branchId = 'test-branch'
		const runId = 'run-live-image-follow-up'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-live-image-follow-up'
		}
		const uploadId = 'live-follow-up.png'

		mkdirSync(join(dir, 'uploads'), { recursive: true })
		writeFileSync(
			join(dir, 'uploads', uploadId),
			new Uint8Array(Buffer.from('img:live-follow-up'))
		)

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Starting the image now.', {
				stopReason: 'toolUse'
			}),
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentDeliveries).toEqual([
			{
				kind: 'message',
				target,
				text: 'Starting the image now.'
			}
		])

		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-live-image',
				args: { prompt: 'bonobo' },
				status: 'complete',
				result: {
					content: [
						{
							type: 'text',
							text: 'Generated bonobo image'
						}
					],
					details: {
						success: true,
						uploadId
					}
				}
			},
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentDeliveries).toHaveLength(1)
		expect(sentComposing.length).toBeGreaterThan(0)

		const imgRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here is the image.'),
			runId
		)

		// Artifact linking the image to the assistant message
		store.appendEvent(
			branchId,
			'assistant_artifact',
			{
				assistantRowId: imgRow.id,
				kind: 'media' as const,
				origin: 'tool_upload' as const,
				uploadId,
				mimeType: 'image/png'
			},
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentDeliveries).toEqual([
			{
				kind: 'message',
				target,
				text: 'Starting the image now.'
			},
			{
				kind: 'media',
				target,
				caption: 'Here is the image.',
				fileName: uploadId
			}
		])

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 100))

		expect(sentDeliveries).toEqual([
			{
				kind: 'message',
				target,
				text: 'Starting the image now.'
			},
			{
				kind: 'media',
				target,
				caption: 'Here is the image.',
				fileName: uploadId
			}
		])
	})

	test('run_closed sends completed assistant messages in order', async () => {
		const branchId = 'test-branch'
		const runId = 'run-last-message'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-last'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload(
				'Let me generate a few options.',
				{ stopReason: 'toolUse' }
			),
			runId
		)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here are the final options.'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(2)
		expect(sentMessages[0].text).toBe(
			'Let me generate a few options.'
		)
		expect(sentMessages[1].text).toBe(
			'Here are the final options.'
		)
	})

	test('does not deliver for non-channel runs', async () => {
		const branchId = 'test-branch'
		registry.watchBranch(branchId)

		// Emit run_closed without registering any delivery
		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			'unregistered-run'
		)

		await new Promise(r => setTimeout(r, 150))
		expect(sentMessages).toHaveLength(0)
	})

	test('watchBranch is idempotent', () => {
		registry.watchBranch('test-branch')
		registry.watchBranch('test-branch')
		// No error, no duplicate subscriptions
	})

	test('shutdown clears state', () => {
		registry.register('run-1', 'test-branch', {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		})
		registry.watchBranch('test-branch')
		registry.shutdown()
		// After shutdown, a new watchBranch should work
		registry.watchBranch('test-branch')
	})

	test('fans out to multiple contributing targets', async () => {
		const branchId = 'test-branch'
		const runId = 'run-multi'

		const target1: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}
		const target2: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-2'
		}

		registry.register(runId, branchId, target1)
		registry.register(runId, branchId, target2)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Reply to both'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(2)
		const convIds = sentMessages.map(
			m => m.target.conversationId
		)
		expect(convIds).toContain('conv-1')
		expect(convIds).toContain('conv-2')
		expect(sentMessages[0].text).toBe('Reply to both')
		expect(sentMessages[1].text).toBe('Reply to both')
	})

	test('deduplicates same target registered twice', async () => {
		const branchId = 'test-branch'
		const runId = 'run-dedup'

		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}

		registry.register(runId, branchId, target)
		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Once only'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)
	})

	test('registerPending promotes to run delivery on runId backfill', async () => {
		const branchId = 'test-branch'
		const runId = 'run-pending'

		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-pending'
		}

		// Persist a user_message without runId
		const row = store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now()
			}
		)

		// Register pending against the row
		registry.registerPending(row.id, branchId, target)
		registry.watchBranch(branchId)

		// Backfill the runId — this should promote the pending entry
		store.updateEventRunId(row.id, runId, branchId)

		// Now persist assistant reply and close the run
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Pending resolved'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Pending resolved')
		expect(sentMessages[0].target).toEqual(target)
	})

	test('persists per-item checkpoint events after delivery', async () => {
		const branchId = 'test-branch'
		const runId = 'run-checkpoints'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-checkpoints'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Checkpoint test'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)

		// Verify per-item checkpoint was persisted
		const checkpoints = eventStore.query({
			branchId,
			types: ['channel_delivered'],
			runId
		})
		expect(checkpoints).toHaveLength(1)
		const cp = parseCheckpoint(checkpoints[0])
		expect(cp.channelId).toBe('test')
		expect(cp.accountId).toBe('default')
		expect(cp.conversationId).toBe('conv-checkpoints')
		expect(cp.replyIndex).toBe(0)
		expect(cp.payloadIndex).toBe(0)
		expect(cp.attachmentIndex).toBe(0)
		expect(cp.kind).toBe('message')
	})

	test('persists separate checkpoints for multi-reply runs', async () => {
		const branchId = 'test-branch'
		const runId = 'run-multi-cp'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-multi-cp'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('First reply', {
				stopReason: 'toolUse'
			}),
			runId
		)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Second reply'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(2)

		const checkpoints = eventStore.query({
			branchId,
			types: ['channel_delivered'],
			runId
		})
		expect(checkpoints).toHaveLength(2)

		const cp0 = parseCheckpoint(checkpoints[0])
		expect(cp0.replyIndex).toBe(0)
		expect(cp0.kind).toBe('message')

		const cp1 = parseCheckpoint(checkpoints[1])
		expect(cp1.replyIndex).toBe(1)
		expect(cp1.kind).toBe('message')
	})

	test('persists per-attachment checkpoints for multi-image reply', async () => {
		const branchId = 'test-branch'
		const runId = 'run-multi-img-cp'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-multi-img-cp'
		}

		const uploadIds = [
			'cp-img-1.png',
			'cp-img-2.png',
			'cp-img-3.png'
		]
		mkdirSync(join(dir, 'uploads'), { recursive: true })
		for (const id of uploadIds) {
			writeFileSync(
				join(dir, 'uploads', id),
				new Uint8Array(Buffer.from(`img:${id}`))
			)
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		const imgMsgRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here are your images'),
			runId
		)

		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-cp-multi',
				args: { prompt: 'cats' },
				status: 'complete',
				result: {
					content: [
						{
							type: 'text',
							text: 'Generated'
						}
					],
					details: {
						success: true,
						uploadId: uploadIds[0],
						images: uploadIds.map(uploadId => ({
							uploadId
						}))
					}
				}
			},
			runId
		)

		// Artifacts linking each image to the assistant message
		for (const id of uploadIds) {
			store.appendEvent(
				branchId,
				'assistant_artifact',
				{
					assistantRowId: imgMsgRow.id,
					kind: 'media' as const,
					origin: 'tool_upload' as const,
					uploadId: id,
					mimeType: 'image/png'
				},
				runId
			)
		}

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMedia).toHaveLength(3)

		// 3 media checkpoints (one per attachment)
		const checkpoints = eventStore.query({
			branchId,
			types: ['channel_delivered'],
			runId
		})
		expect(checkpoints).toHaveLength(3)

		for (const [i, cp] of checkpoints
			.map(parseCheckpoint)
			.entries()) {
			expect(cp.replyIndex).toBe(0)
			expect(cp.payloadIndex).toBe(0)
			expect(cp.attachmentIndex).toBe(i)
			expect(cp.kind).toBe('media')
		}
	})

	test('recoverUndelivered re-delivers stranded channel runs', async () => {
		const branchId = 'test-branch'
		const runId = 'run-stranded'

		// Simulate a channel user_message with source metadata
		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-stranded',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		// Simulate assistant reply
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Recovered reply'),
			runId
		)

		// Simulate run_closed (but NO checkpoints — crash scenario)
		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Now recover
		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(1)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Recovered reply')
		expect(sentMessages[0].target.conversationId).toBe(
			'conv-stranded'
		)

		// Verify per-item checkpoint was written
		const checkpoints = eventStore.query({
			branchId,
			types: ['channel_delivered'],
			runId
		})
		expect(checkpoints).toHaveLength(1)
		const cp = parseCheckpoint(checkpoints[0])
		expect(cp.replyIndex).toBe(0)
		expect(cp.kind).toBe('message')
	})

	test('recoverUndelivered skips fully-checkpointed runs', async () => {
		const branchId = 'test-branch'
		const runId = 'run-already'

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-already',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Already sent'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Already has a per-item checkpoint
		store.appendEvent(
			branchId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-already',
				assistantRowId: assistantRow.id,
				replyIndex: 0,
				payloadIndex: 0,
				attachmentIndex: 0,
				kind: 'message' as const,
				deliveredAt: Date.now()
			},
			runId
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(0)
		expect(sentMessages).toHaveLength(0)
	})

	test('recoverUndelivered resumes from exact partial delivery point', async () => {
		const branchId = 'test-branch'
		const runId = 'run-partial'

		const uploadIds = [
			'partial-1.png',
			'partial-2.png',
			'partial-3.png'
		]
		mkdirSync(join(dir, 'uploads'), { recursive: true })
		for (const id of uploadIds) {
			writeFileSync(
				join(dir, 'uploads', id),
				new Uint8Array(Buffer.from(`img:${id}`))
			)
		}

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-partial',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here are images'),
			runId
		)

		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-partial',
				args: { prompt: 'cats' },
				status: 'complete',
				result: {
					content: [{ type: 'text', text: 'Generated' }],
					details: {
						success: true,
						uploadId: uploadIds[0],
						images: uploadIds.map(uploadId => ({
							uploadId
						}))
					}
				}
			},
			runId
		)

		// Artifacts linking each image to the assistant message
		for (const id of uploadIds) {
			store.appendEvent(
				branchId,
				'assistant_artifact',
				{
					assistantRowId: assistantRow.id,
					kind: 'media' as const,
					origin: 'tool_upload' as const,
					uploadId: id,
					mimeType: 'image/png'
				},
				runId
			)
		}

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Simulate: first attachment was sent before crash
		store.appendEvent(
			branchId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-partial',
				assistantRowId: assistantRow.id,
				replyIndex: 0,
				payloadIndex: 0,
				attachmentIndex: 0,
				kind: 'media' as const,
				deliveredAt: Date.now()
			},
			runId,
			`channel_delivered:${runId}:test:default:conv-partial:r0:p0:a0`
		)

		// Recovery should send only attachments 1 and 2
		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(1)
		expect(sentMedia).toHaveLength(2)
		expect(sentMedia[0].media.fileName).toBe(
			'partial-2.png'
		)
		expect(sentMedia[1].media.fileName).toBe(
			'partial-3.png'
		)
		// Caption only on attachment 0 which was already sent
		expect(sentMedia[0].caption).toBe('')
		expect(sentMedia[1].caption).toBe('')
	})

	test('recoverUndelivered resumes pending voice note after media already sent', async () => {
		const branchId = 'test-branch'
		const runId = 'run-partial-media-tts'
		const imageUploadId = 'partial-media-tts.png'
		const audioUploadId = 'partial-media-tts.opus'

		mkdirSync(join(dir, 'uploads'), { recursive: true })
		writeFileSync(
			join(dir, 'uploads', imageUploadId),
			new Uint8Array(Buffer.from('img:partial-media-tts'))
		)
		writeFileSync(
			join(dir, 'uploads', audioUploadId),
			new Uint8Array(Buffer.from('audio:partial-media-tts'))
		)

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-partial-media-tts',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			{
				...makeAssistantPayload('Here is the bonobo.'),
				ttsDirective: { params: undefined }
			},
			runId
		)

		// Image artifact (compiled server-side from tool_upload)
		store.appendEvent(
			branchId,
			'assistant_artifact',
			{
				assistantRowId: assistantRow.id,
				kind: 'media' as const,
				origin: 'tool_upload' as const,
				uploadId: imageUploadId,
				mimeType: 'image/png'
			},
			runId
		)

		// TTS post-processor mock: emits audio artifact when called during recovery
		registry.setTtsPostProcessor({
			processRun: async (_rid: string, _sid: string) => {
				store.appendEvent(
					branchId,
					'assistant_artifact',
					{
						assistantRowId: assistantRow.id,
						kind: 'audio' as const,
						origin: 'tts' as const,
						uploadId: audioUploadId,
						url: `/api/uploads-rpc/${audioUploadId}/content`,
						mimeType: 'audio/ogg',
						size: 23,
						synthesizedText: 'Here is the bonobo.'
					},
					runId
				)
			}
		} as unknown as Parameters<
			ChannelDeliveryRegistry['setTtsPostProcessor']
		>[0])

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Simulate: the image payload was already sent before crash.
		store.appendEvent(
			branchId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-partial-media-tts',
				assistantRowId: assistantRow.id,
				replyIndex: 0,
				payloadIndex: 0,
				attachmentIndex: 0,
				kind: 'media' as const,
				deliveredAt: Date.now()
			},
			runId,
			`channel_delivered:${runId}:test:default:conv-partial-media-tts:r0:p0:a0`
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)

		expect(recovered).toBe(1)
		expect(sentMessages).toHaveLength(0)
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].caption).toBe('')
		expect(sentMedia[0].media.fileName).toBe(audioUploadId)

		const checkpoints = eventStore
			.query({
				branchId,
				runId,
				types: ['channel_delivered']
			})
			.map(parseCheckpoint)
		expect(checkpoints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					replyIndex: 0,
					payloadIndex: 1,
					attachmentIndex: 0,
					kind: 'audio_voice'
				})
			])
		)
	})

	test('recoverUndelivered resumes partial multi-reply run', async () => {
		const branchId = 'test-branch'
		const runId = 'run-partial-multi'

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-partial-multi',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		const reply0 = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('First reply', {
				stopReason: 'toolUse'
			}),
			runId
		)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Second reply'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// First reply was already delivered
		store.appendEvent(
			branchId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-partial-multi',
				assistantRowId: reply0.id,
				replyIndex: 0,
				payloadIndex: 0,
				attachmentIndex: 0,
				kind: 'message' as const,
				deliveredAt: Date.now()
			},
			runId,
			`channel_delivered:${runId}:test:default:conv-partial-multi:r0:p0:a0`
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(1)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Second reply')
	})

	test('duplicate recovery calls are idempotent', async () => {
		const branchId = 'test-branch'
		const runId = 'run-idempotent'

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-idempotent',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Idempotent test'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// First recovery
		const first =
			await registry.recoverUndelivered(eventStore)
		expect(first).toBe(1)
		expect(sentMessages).toHaveLength(1)

		// Second recovery — should find all checkpoints and skip
		const second =
			await registry.recoverUndelivered(eventStore)
		expect(second).toBe(0)
		expect(sentMessages).toHaveLength(1) // no new sends
	})

	test('recoverUndelivered skips runs with unavailable provider', async () => {
		const branchId = 'test-branch'
		const runId = 'run-noprovider'

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'unknown-channel',
					accountId: 'default',
					conversationId: 'conv-noprovider',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('No provider'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(0)
		expect(sentMessages).toHaveLength(0)
	})

	test('stale run recovery triggers delivery when registry is watching', async () => {
		const branchId = 'test-branch'
		const runId = 'run-stale'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-stale'
		}

		// Register target and watch BEFORE the run closes
		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		// Persist assistant reply
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Stale recovery'),
			runId
		)

		// Simulate what recoverStaleRuns does at startup:
		// appends run_closed WHILE registry is watching
		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'recovered_after_crash' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Stale recovery')
	})

	test('web/internal runs never deliver externally', async () => {
		const branchId = 'test-branch'
		registry.watchBranch(branchId)

		// Simulate a purely internal run (no register/registerPending)
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Internal only'),
			'internal-run'
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			'internal-run'
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(0)
	})

	test('sends composing indicator when tool_execution is appended', async () => {
		const branchId = 'test-branch'
		const runId = 'run-composing'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-composing'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		// Append a tool_execution event (status=running)
		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-composing',
				args: { prompt: 'a cat' },
				status: 'running'
			},
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentComposing).toHaveLength(1)
		expect(sentComposing[0].target).toEqual(target)
	})

	test('sends composing indicator when assistant_message is appended', async () => {
		const branchId = 'test-branch'
		const runId = 'run-composing-msg'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-composing-msg'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Thinking...', {
				stopReason: 'toolUse'
			}),
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentComposing).toHaveLength(1)
		expect(sentComposing[0].target).toEqual(target)
	})

	test('does not send composing for non-channel runs', async () => {
		const branchId = 'test-branch'
		registry.watchBranch(branchId)

		// Tool execution on a run with no registered targets
		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-no-target',
				args: { prompt: 'a dog' },
				status: 'running'
			},
			'unregistered-run'
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentComposing).toHaveLength(0)
	})

	test('queues media from multiple tool calls until the next assistant message', async () => {
		const branchId = 'test-branch'
		const runId = 'run-multi-step-media'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-multi-step-media'
		}
		const uploadIds = [
			'step-1.png',
			'step-2a.png',
			'step-2b.png',
			'step-2c.png',
			'step-3a.png',
			'step-3b.png'
		]

		mkdirSync(join(dir, 'uploads'), { recursive: true })
		for (const uploadId of uploadIds) {
			writeFileSync(
				join(dir, 'uploads', uploadId),
				new Uint8Array(Buffer.from(`img:${uploadId}`))
			)
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		// Reply 0: text only (no media)
		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload(
				'Sure! I will make imgs one by one.',
				{ stopReason: 'toolUse' }
			),
			runId
		)

		// tool_execution for step-1
		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-1',
				args: { prompt: 'img 1' },
				status: 'complete',
				result: {
					content: [
						{ type: 'text', text: `Generated step-1.png` }
					],
					details: { success: true, uploadId: 'step-1.png' }
				}
			},
			runId
		)

		// Reply 1: "Here you go!" with step-1 artifact
		const reply1 = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here you go!', {
				stopReason: 'toolUse'
			}),
			runId
		)
		store.appendEvent(
			branchId,
			'assistant_artifact',
			{
				assistantRowId: reply1.id,
				kind: 'media' as const,
				origin: 'tool_upload' as const,
				uploadId: 'step-1.png',
				mimeType: 'image/png'
			},
			runId
		)

		// tool_executions for step-2a, 2b, 2c
		for (const uploadId of [
			'step-2a.png',
			'step-2b.png',
			'step-2c.png'
		]) {
			store.appendEvent(
				branchId,
				'tool_execution',
				{
					toolName: 'generate_image',
					toolCallId: `tc-${uploadId}`,
					args: { prompt: `img ${uploadId}` },
					status: 'complete',
					result: {
						content: [
							{
								type: 'text',
								text: `Generated ${uploadId}`
							}
						],
						details: { success: true, uploadId }
					}
				},
				runId
			)
		}

		// Reply 2: "Made img 2" with step-2a, 2b, 2c artifacts
		const reply2 = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Made img 2', {
				stopReason: 'toolUse'
			}),
			runId
		)
		for (const uploadId of [
			'step-2a.png',
			'step-2b.png',
			'step-2c.png'
		]) {
			store.appendEvent(
				branchId,
				'assistant_artifact',
				{
					assistantRowId: reply2.id,
					kind: 'media' as const,
					origin: 'tool_upload' as const,
					uploadId,
					mimeType: 'image/png'
				},
				runId
			)
		}

		// tool_executions for step-3a, 3b
		for (const uploadId of ['step-3a.png', 'step-3b.png']) {
			store.appendEvent(
				branchId,
				'tool_execution',
				{
					toolName: 'generate_image',
					toolCallId: `tc-${uploadId}`,
					args: { prompt: `img ${uploadId}` },
					status: 'complete',
					result: {
						content: [
							{
								type: 'text',
								text: `Generated ${uploadId}`
							}
						],
						details: { success: true, uploadId }
					}
				},
				runId
			)
		}

		// Reply 3: "Made img 3" with step-3a, 3b artifacts
		const reply3 = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Made img 3'),
			runId
		)
		for (const uploadId of ['step-3a.png', 'step-3b.png']) {
			store.appendEvent(
				branchId,
				'assistant_artifact',
				{
					assistantRowId: reply3.id,
					kind: 'media' as const,
					origin: 'tool_upload' as const,
					uploadId,
					mimeType: 'image/png'
				},
				runId
			)
		}

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe(
			'Sure! I will make imgs one by one.'
		)
		expect(sentMedia).toHaveLength(6)
		expect(sentDeliveries).toEqual([
			{
				kind: 'message',
				target,
				text: 'Sure! I will make imgs one by one.'
			},
			{
				kind: 'media',
				target,
				caption: 'Here you go!',
				fileName: 'step-1.png'
			},
			{
				kind: 'media',
				target,
				caption: 'Made img 2',
				fileName: 'step-2a.png'
			},
			{
				kind: 'media',
				target,
				caption: '',
				fileName: 'step-2b.png'
			},
			{
				kind: 'media',
				target,
				caption: '',
				fileName: 'step-2c.png'
			},
			{
				kind: 'media',
				target,
				caption: 'Made img 3',
				fileName: 'step-3a.png'
			},
			{
				kind: 'media',
				target,
				caption: '',
				fileName: 'step-3b.png'
			}
		])
	})

	test('auto-appends generate_image media to reply payload', async () => {
		const branchId = 'test-branch'
		const runId = 'run-img'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-img'
		}

		// Create a real temp file so resolveMedia can read it
		const imgPath = join(tmpdir(), 'test-img-gen.png')
		const imgContent = Buffer.from('fake-png-content')
		writeFileSync(imgPath, new Uint8Array(imgContent))

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		// Assistant text
		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Here is your image'),
			runId
		)

		// Completed tool_execution for generate_image
		const uploadId = 'upload-123.png'
		const uploadedPath = join(dir, 'uploads', uploadId)
		mkdirSync(join(dir, 'uploads'), { recursive: true })
		writeFileSync(uploadedPath, new Uint8Array(imgContent))
		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-1',
				args: { prompt: 'a cat' },
				status: 'complete',
				result: {
					content: [
						{
							type: 'text',
							text: 'Image generated'
						}
					],
					details: {
						success: true,
						uploadId
					}
				}
			},
			runId
		)

		// Artifact linking the image to the assistant message
		store.appendEvent(
			branchId,
			'assistant_artifact',
			{
				assistantRowId: assistantRow.id,
				kind: 'media' as const,
				origin: 'tool_upload' as const,
				uploadId,
				mimeType: 'image/png'
			},
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		// Should call sendMedia (not sendMessage) via resolveMedia → provider.sendMedia
		expect(sentMessages).toHaveLength(0)
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].caption).toBe('Here is your image')
		expect(sentMedia[0].target).toEqual(target)
		expect(sentMedia[0].media.mimetype).toBe('image/png')
		expect(sentMedia[0].media.buffer).toEqual(imgContent)

		// Cleanup
		rmSync(imgPath, { force: true })
	})

	test('auto-appends every generated image and captions only the first attachment', async () => {
		const branchId = 'test-branch'
		const runId = 'run-img-multi'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-img-multi'
		}

		const uploadIds = [
			'upload-1.png',
			'upload-2.png',
			'upload-3.png'
		]
		mkdirSync(join(dir, 'uploads'), { recursive: true })
		for (const uploadId of uploadIds) {
			writeFileSync(
				join(dir, 'uploads', uploadId),
				new Uint8Array(Buffer.from(`img:${uploadId}`))
			)
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload(
				'Pick the one you want to refine.'
			),
			runId
		)

		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-multi',
				args: { prompt: 'a cat' },
				status: 'complete',
				result: {
					content: [
						{
							type: 'text',
							text: 'Images generated'
						}
					],
					details: {
						success: true,
						uploadId: uploadIds[0],
						images: uploadIds.map(uploadId => ({
							uploadId
						}))
					}
				}
			},
			runId
		)

		// Artifacts linking each image to the assistant message
		for (const uploadId of uploadIds) {
			store.appendEvent(
				branchId,
				'assistant_artifact',
				{
					assistantRowId: assistantRow.id,
					kind: 'media' as const,
					origin: 'tool_upload' as const,
					uploadId,
					mimeType: 'image/png'
				},
				runId
			)
		}

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(sentMedia).toHaveLength(3)
		expect(
			sentMedia.map(entry => entry.media.fileName)
		).toEqual(uploadIds)
		expect(sentMedia[0].caption).toBe(
			'Pick the one you want to refine.'
		)
		expect(sentMedia[1].caption).toBe('')
		expect(sentMedia[2].caption).toBe('')
		expect(sentMessages).toHaveLength(0)
	})

	test('failed generate_image does not add media', async () => {
		const branchId = 'test-branch'
		const runId = 'run-img-fail'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-img-fail'
		}

		registry.register(runId, branchId, target)
		registry.watchBranch(branchId)

		store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Image failed'),
			runId
		)

		// Failed tool_execution
		store.appendEvent(
			branchId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-2',
				args: { prompt: 'a dog' },
				status: 'error',
				result: {
					content: [
						{
							type: 'text',
							text: 'Generation failed'
						}
					],
					details: { success: false }
				}
			},
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		// Should send text-only via sendMessage (no sendMedia call)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Image failed')
		expect(sentMedia).toHaveLength(0)
	})

	test('one target fully delivered while another resumes from middle', async () => {
		const branchId = 'test-branch'
		const runId = 'run-multi-target-partial'

		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-target-a',
					senderId: 'user-1'
				}
			},
			runId
		)

		// Second user_message from different conversation in same run
		store.appendEvent(
			branchId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-target-b',
					senderId: 'user-2'
				}
			},
			runId
		)

		const assistantRow = store.appendEvent(
			branchId,
			'assistant_message',
			makeAssistantPayload('Reply to both targets'),
			runId
		)

		store.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Target A is fully delivered
		store.appendEvent(
			branchId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-target-a',
				assistantRowId: assistantRow.id,
				replyIndex: 0,
				payloadIndex: 0,
				attachmentIndex: 0,
				kind: 'message' as const,
				deliveredAt: Date.now()
			},
			runId,
			`channel_delivered:${runId}:test:default:conv-target-a:r0:p0:a0`
		)

		// Target B has NO checkpoints

		const recovered =
			await registry.recoverUndelivered(eventStore)
		// Should recover 1 (target B only)
		expect(recovered).toBe(1)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].target.conversationId).toBe(
			'conv-target-b'
		)
	})
})
