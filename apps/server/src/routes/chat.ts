/**
 * Chat routes — branches, messages, and SSE event streams.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia, sse } from 'elysia'
import { hash } from 'ohash'
import * as v from 'valibot'
import type {
	RealtimeStore,
	BranchEvent
} from '../lib/realtime-store'
import type { AgentController } from '../agent/controller'
import type { EventStore } from '@ellie/db'
import {
	agentMessageSchema,
	type UserMessage
} from '@ellie/schemas/agent'
import {
	branchParamsSchema,
	afterSeqQuerySchema,
	eventsQuerySchema,
	messageInputSchema,
	normalizeMessageInput,
	toStreamGenerator,
	type SseState
} from './common'
import { errorSchema } from './schemas/common-schemas'
import {
	branchSchema,
	eventRowListSchema,
	postMessageResponseSchema,
	clearBranchResponseSchema
} from './schemas/chat-schemas'
import {
	BadRequestError,
	HttpError,
	NotFoundError,
	ServiceUnavailableError
} from './http-errors'
import type { FileStore } from '@ellie/tus'
import { join } from 'node:path'
import { generateThumbHash } from '../lib/thumbhash'
import { extractImageDimensions } from '../lib/image-dimensions'
import {
	readUploadBytes,
	isTextContent
} from '../lib/attachment-resolver'
import { validateSpeechArtifact } from '../lib/speech-validation'
import { requireLoopback } from './loopback-guard'

function buildUploadUrl(uploadId: string): string {
	return `/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`
}

export interface ChatRoutesDeps {
	store: RealtimeStore
	sseState: SseState
	getAgentController?: () => Promise<AgentController | null>
	ensureBootstrap?: (
		branchId: string,
		runId: string
	) => void
	uploadStore?: FileStore
	eventStore?: EventStore
}

export function createChatRoutes(deps: ChatRoutesDeps) {
	const {
		store,
		sseState,
		getAgentController,
		ensureBootstrap,
		uploadStore,
		eventStore
	} = deps
	return new Elysia({ prefix: '/api/chat', tags: ['Chat'] })
		.onBeforeHandle(requireLoopback)

		.get(
			'/branches/:branchId',
			({ params }) => {
				const branchId = params.branchId
				const branch = store.getBranch(branchId)
				if (!branch) {
					throw new NotFoundError('Branch not found')
				}
				return branch
			},
			{
				params: branchParamsSchema,
				response: {
					200: branchSchema,
					404: errorSchema
				}
			}
		)

		.get(
			'/branches/:branchId/messages',
			({ params }) => {
				const branchId = params.branchId
				return store.listAgentMessages(branchId)
			},
			{
				params: branchParamsSchema,
				response: {
					200: v.array(agentMessageSchema)
				}
			}
		)

		.post(
			'/branches/:branchId/messages',
			async ({ params, body }) => {
				const branchId = params.branchId
				const input = normalizeMessageInput(body)
				store.ensureBranch(branchId)

				// Reject writes to view_only threads
				const branch = store.getBranch(branchId)
				if (branch) {
					const thread = store.getThread(branch.threadId)
					if (thread?.state === 'view_only') {
						throw new BadRequestError(
							'Cannot post to a view-only thread'
						)
					}
				}

				// Build content parts: text + attachments
				const contentParts: UserMessage['content'] = []
				const trimmed = input.content.trim()
				if (trimmed) {
					contentParts.push({
						type: 'text',
						text: trimmed
					})
				}
				if (input.attachments && uploadStore) {
					for (const att of input.attachments) {
						const mime = att.mime
						const base = {
							file: att.uploadId,
							url: buildUploadUrl(att.uploadId),
							mime: att.mime,
							size: att.size,
							name: att.name,
							path: join(
								uploadStore.directory,
								att.uploadId
							)
						}
						if (mime.startsWith('image/')) {
							const bytes = await readUploadBytes(
								uploadStore,
								att.uploadId
							)
							const dims = extractImageDimensions(bytes)
							const hash = await generateThumbHash(
								bytes
							).catch(() => undefined)
							contentParts.push({
								...base,
								type: 'image',
								data: bytes.toString('base64'),
								mimeType: att.mime,
								...(dims && {
									width: dims.width,
									height: dims.height
								}),
								...(hash && { hash })
							})
						} else if (isTextContent(mime, att.name)) {
							const bytes = await readUploadBytes(
								uploadStore,
								att.uploadId
							)
							contentParts.push({
								...base,
								type: 'file',
								textContent: new TextDecoder().decode(bytes)
							})
						} else if (mime.startsWith('video/')) {
							contentParts.push({
								...base,
								type: 'video'
							})
						} else if (mime.startsWith('audio/')) {
							contentParts.push({
								...base,
								type: 'audio'
							})
						} else {
							contentParts.push({
								...base,
								type: 'file'
							})
						}
					}
				}

				// Resolve speech metadata from speechRef (if provided)
				let speechMeta: UserMessage['speech'] | undefined
				if (input.speechRef && eventStore) {
					const artifact = eventStore.speechArtifacts.get(
						input.speechRef
					)
					if (!artifact || artifact.status !== 'draft') {
						throw new BadRequestError(
							'Invalid or already-claimed speechRef'
						)
					}
					speechMeta = validateSpeechArtifact(artifact)
				}

				// Persist user message BEFORE bootstrap so the client
				// sees the user bubble first, then the synthetic tool call.
				const dedupeWindow = Math.floor(Date.now() / 2000)
				const contentHash = hash(input.content)
				const dedupeKey = `user_msg:${branchId}:${dedupeWindow}:${contentHash}`

				const beforeAppend = Date.now()
				const row = store.appendEvent(
					branchId,
					'user_message',
					{
						role: 'user',
						content: contentParts,
						timestamp: beforeAppend,
						...(speechMeta ? { speech: speechMeta } : {})
					},
					undefined, // runId — backfilled later by controller
					dedupeKey
				)

				// Claim the speech artifact now that the event is persisted
				if (speechMeta && eventStore) {
					const claimed = eventStore.speechArtifacts.claim(
						speechMeta.ref,
						row.id,
						branchId
					)
					if (!claimed) {
						console.warn(
							`[chat] Speech artifact claim race: ref=${speechMeta.ref} branchId=${branchId} eventId=${row.id} — artifact was already claimed or expired`
						)
					}
				}

				// Dedupe hit: appendEvent returned an existing row
				if (row.createdAt < beforeAppend) {
					return {
						id: row.id,
						seq: row.seq,
						branchId: row.branchId,
						deduplicated: true
					}
				}

				// Route the message directly to the agent controller.
				let result:
					| {
							runId: string
							routed: 'prompt' | 'followUp' | 'queued'
							traceId?: string
					  }
					| undefined
				try {
					const controller = await getAgentController?.()
					if (!controller) {
						throw new ServiceUnavailableError(
							'Agent is not available — check API credentials'
						)
					}
					result = await controller.handleMessage(
						branchId,
						input.content,
						row.id
					)
				} catch (err) {
					if (err instanceof HttpError) throw err
					throw new BadRequestError(
						err instanceof Error
							? err.message
							: 'Message routing failed'
					)
				}

				if (result) {
					ensureBootstrap?.(branchId, result.runId)
				}

				return {
					id: row.id,
					seq: row.seq,
					branchId: row.branchId,
					...(result
						? {
								runId: result.runId,
								traceId: result.traceId,
								routed: result.routed
							}
						: {})
				}
			},
			{
				params: branchParamsSchema,
				body: messageInputSchema,
				response: {
					200: postMessageResponseSchema,
					400: errorSchema
				}
			}
		)

		.delete(
			'/branches/:branchId/messages',
			({ params }) => {
				const branchId = params.branchId
				store.deleteBranch(branchId)
				return new Response(null, { status: 204 })
			},
			{ params: branchParamsSchema }
		)

		.post(
			'/branches/:branchId/fork',
			({ params, body }) => {
				const branchId = params.branchId
				const branch = store.getBranch(branchId)
				if (!branch) {
					throw new NotFoundError('Branch not found')
				}
				const thread = store.getThread(branch.threadId)
				if (thread?.agentType === 'assistant') {
					throw new BadRequestError(
						'Cannot fork assistant thread branches'
					)
				}
				const child = store.forkBranch(
					branchId,
					body.fromEventId,
					body.fromSeq
				)
				return child
			},
			{
				params: branchParamsSchema,
				body: v.object({
					fromEventId: v.number(),
					fromSeq: v.number()
				}),
				response: {
					200: branchSchema
				}
			}
		)

		.get(
			'/branches/:branchId/events',
			({ params, query }) => {
				const branchId = params.branchId
				const afterSeq = query.afterSeq
				const limit = query.limit
					? Number(query.limit)
					: undefined
				return store.queryLineageEvents(
					branchId,
					afterSeq,
					undefined,
					limit
				)
			},
			{
				params: branchParamsSchema,
				query: eventsQuerySchema,
				response: { 200: eventRowListSchema }
			}
		)

		.get(
			'/branches/:branchId/events/sse',
			({ params, query, request }) => {
				const branchId = params.branchId
				const afterSeq = query.afterSeq

				// Use lineage-aware query so forked branches
				// include inherited ancestor events in the snapshot
				const existingEvents = store.queryLineageEvents(
					branchId,
					afterSeq
				)

				const stream = toStreamGenerator<BranchEvent>(
					request,
					sseState,
					listener =>
						store.subscribeToBranch(branchId, listener),
					event => ({
						event: event.type,
						data: event.event
					}),
					{
						event: 'snapshot',
						data: {
							branchId,
							events: existingEvents
						}
					}
				)

				return sse(stream)
			},
			{
				params: branchParamsSchema,
				query: afterSeqQuerySchema
			}
		)

		.post(
			'/branches/:branchId/clear',
			({ params }) => {
				const branchId = params.branchId
				const branch = store.getBranch(branchId)
				if (!branch) {
					throw new NotFoundError('Branch not found')
				}
				store.deleteBranch(branchId)
				// Recreate the branch in the same thread
				// with the same ID so SSE subscribers stay valid
				const newBranch = store.eventStore.createBranch(
					branch.threadId,
					undefined,
					undefined,
					undefined,
					branchId
				)
				return {
					branchId: newBranch.id,
					cleared: true
				}
			},
			{
				params: branchParamsSchema,
				response: {
					200: clearBranchResponseSchema
				}
			}
		)
}
