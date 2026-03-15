/**
 * Chat routes — sessions, messages, and SSE event streams.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia, sse } from 'elysia'
import { hash } from 'ohash'
import * as v from 'valibot'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentController } from '../agent/controller'
import type { EventStore } from '@ellie/db'
import {
	agentMessageSchema,
	type UserMessage
} from '@ellie/schemas/agent'
import {
	sessionParamsSchema,
	afterSeqQuerySchema,
	eventsQuerySchema,
	messageInputSchema,
	normalizeMessageInput,
	resolveSessionId,
	toStreamGenerator,
	type SseState
} from './common'
import { errorSchema } from './schemas/common-schemas'
import {
	sessionSchema,
	sessionListSchema,
	eventRowListSchema,
	postMessageResponseSchema,
	clearSessionResponseSchema
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
		sessionId: string,
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

		.post(
			'/sessions',
			() => {
				const session = store.createSession()
				return session
			},
			{
				response: { 200: sessionSchema }
			}
		)

		.get(
			'/sessions',
			() => {
				return store.listSessions()
			},
			{
				response: { 200: sessionListSchema }
			}
		)

		.get(
			'/sessions/:sessionId',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const session = store.getSession(sessionId)
				if (!session) {
					throw new NotFoundError('Session not found')
				}
				return session
			},
			{
				params: sessionParamsSchema,
				response: {
					200: sessionSchema,
					404: errorSchema
				}
			}
		)

		.get(
			'/:sessionId/messages',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				return store.listAgentMessages(sessionId)
			},
			{
				params: sessionParamsSchema,
				response: {
					200: v.array(agentMessageSchema)
				}
			}
		)

		.post(
			'/:sessionId/messages',
			async ({ params, body }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const input = normalizeMessageInput(body)
				store.ensureSession(sessionId)

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
				// Dedupe key: reject rapid-fire duplicate POSTs with the
				// same content (e.g. key repeat on Enter). Window ~ 2s.
				const dedupeWindow = Math.floor(Date.now() / 2000)
				const contentHash = hash(input.content)
				const dedupeKey = `user_msg:${sessionId}:${dedupeWindow}:${contentHash}`

				const beforeAppend = Date.now()
				const row = store.appendEvent(
					sessionId,
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
						sessionId
					)
					if (!claimed) {
						console.warn(
							`[chat] Speech artifact claim race: ref=${speechMeta.ref} sessionId=${sessionId} eventId=${row.id} — artifact was already claimed or expired`
						)
					}
				}

				// Dedupe hit: appendEvent returned an existing row
				// (createdAt will be older than our beforeAppend timestamp)
				if (row.createdAt < beforeAppend) {
					return {
						id: row.id,
						seq: row.seq,
						sessionId: row.sessionId,
						deduplicated: true
					}
				}

				// Route the message directly to the agent controller.
				// handleMessage backfills the runId on the user_message row.
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
						sessionId,
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
					ensureBootstrap?.(sessionId, result.runId)
				}

				return {
					id: row.id,
					seq: row.seq,
					sessionId: row.sessionId,
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
				params: sessionParamsSchema,
				body: messageInputSchema,
				response: {
					200: postMessageResponseSchema,
					400: errorSchema
				}
			}
		)

		.delete(
			'/:sessionId/messages',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				store.deleteSession(sessionId)
				return new Response(null, { status: 204 })
			},
			{ params: sessionParamsSchema }
		)

		.get(
			'/:sessionId/events',
			({ params, query }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const afterSeq = query.afterSeq
				const limit = query.limit
					? Number(query.limit)
					: undefined
				return store.queryEvents(
					sessionId,
					afterSeq,
					undefined,
					limit
				)
			},
			{
				params: sessionParamsSchema,
				query: eventsQuerySchema,
				response: { 200: eventRowListSchema }
			}
		)

		.get(
			'/:sessionId/events/sse',
			({ params, query, request }) => {
				const isCurrent = params.sessionId === 'current'
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const afterSeq = query.afterSeq

				const existingEvents = store.queryEvents(
					sessionId,
					afterSeq
				)

				// For 'current' connections, create a combined abort
				// signal that fires on rotation OR client disconnect.
				// This wakes toStreamGenerator's blocking wait so the
				// client reconnects to the new session.
				let effectiveRequest = request
				let unsubRotation: (() => void) | undefined
				if (isCurrent) {
					const ac = new AbortController()
					const abort = ac.abort.bind(ac)
					request.signal.addEventListener('abort', abort, {
						once: true
					})
					unsubRotation = store.subscribeToRotation(abort)
					effectiveRequest = new Request(request.url, {
						signal: ac.signal
					})
				}

				const stream = toStreamGenerator<SessionEvent>(
					effectiveRequest,
					sseState,
					listener => {
						const unsubSession = store.subscribeToSession(
							sessionId,
							listener
						)
						// Bundle rotation cleanup with session
						// unsubscribe so both are cleaned up by
						// toStreamGenerator's finally block.
						return () => {
							unsubSession()
							unsubRotation?.()
						}
					},
					event => ({
						event: event.type,
						data: event.event
					}),
					{
						event: 'snapshot',
						data: {
							sessionId,
							events: existingEvents
						}
					}
				)

				return sse(stream)
			},
			{
				params: sessionParamsSchema,
				query: afterSeqQuerySchema
			}
		)

		.post(
			'/:sessionId/clear',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				store.deleteSession(sessionId)
				const session = store.createSession(sessionId)
				return {
					sessionId: session.id,
					cleared: true
				}
			},
			{
				params: sessionParamsSchema,
				response: {
					200: clearSessionResponseSchema
				}
			}
		)
}
