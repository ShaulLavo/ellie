/**
 * Chat routes — sessions, messages, and SSE event streams.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia, sse } from 'elysia'
import * as v from 'valibot'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentController } from '../agent/controller'
import { agentMessageSchema } from '@ellie/schemas/agent'
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
	NotFoundError
} from './http-errors'

export function createChatRoutes(
	store: RealtimeStore,
	sseState: SseState,
	getAgentController?: () => Promise<AgentController | null>,
	ensureBootstrap?: (sessionId: string) => void
) {
	return (
		new Elysia({ prefix: '/chat', tags: ['Chat'] })

			// ── Sessions CRUD ───────────────────────────────────────────────

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

			// ── Messages ────────────────────────────────────────────────────

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

					// Persist user message BEFORE bootstrap so the client
					// sees the user bubble first, then the synthetic tool call.
					const row = store.appendEvent(
						sessionId,
						'user_message',
						{
							role: 'user',
							content: [
								{ type: 'text', text: input.content }
							],
							timestamp: Date.now()
						}
					)

					ensureBootstrap?.(sessionId)

					// Route the message directly to the agent controller.
					// handleMessage backfills the runId on the user_message row.
					let result:
						| {
								runId: string
								routed: 'prompt' | 'followUp' | 'queued'
						  }
						| undefined
					try {
						const controller = await getAgentController?.()
						result = controller
							? await controller.handleMessage(
									sessionId,
									input.content,
									row.id
								)
							: undefined
					} catch (err) {
						throw new BadRequestError(
							err instanceof Error
								? err.message
								: 'Message routing failed'
						)
					}

					return {
						id: row.id,
						seq: row.seq,
						sessionId: row.sessionId,
						...(result
							? {
									runId: result.runId,
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

			// ── Events (replay cursor + SSE) ────────────────────────────────

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
						request.signal.addEventListener(
							'abort',
							() => ac.abort(),
							{ once: true }
						)
						unsubRotation = store.subscribeToRotation(() =>
							ac.abort()
						)
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
							data: existingEvents
						}
					)

					return sse(stream)
				},
				{
					params: sessionParamsSchema,
					query: afterSeqQuerySchema
				}
			)

			// ── Session lifecycle ────────────────────────────────────────────

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
	)
}
