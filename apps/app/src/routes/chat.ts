import { Elysia, sse } from 'elysia'
import type { RealtimeStore, SessionEvent } from '../lib/realtime-store'
import {
	sessionParamsSchema,
	afterSeqQuerySchema,
	errorSchema,
	messageInputSchema,
	normalizeMessageInput,
	toStreamGenerator,
	type SseState
} from './common'

export function createChatRoutes(store: RealtimeStore, sseState: SseState) {
	return new Elysia({ prefix: '/chat' })
		.get(
			'/:sessionId/messages',
			({ params }) => {
				return store.listAgentMessages(params.sessionId)
			},
			{
				params: sessionParamsSchema
			}
		)
		.post(
			'/:sessionId/messages',
			({ params, body }) => {
				const input = normalizeMessageInput(body)
				store.ensureSession(params.sessionId)
				const row = store.appendEvent(params.sessionId, 'user_message', {
					role: input.role ?? 'user',
					content: [{ type: 'text', text: input.content }],
					timestamp: Date.now()
				})
				return { id: row.id, seq: row.seq, sessionId: row.sessionId }
			},
			{
				params: sessionParamsSchema,
				body: messageInputSchema,
				response: {
					400: errorSchema
				}
			}
		)
		.delete(
			'/:sessionId/messages',
			({ params }) => {
				store.deleteSession(params.sessionId)
				return new Response(null, { status: 204 })
			},
			{
				params: sessionParamsSchema
			}
		)
		.get(
			'/:sessionId/events/sse',
			({ params, query, request }) => {
				const afterSeq = query.afterSeq

				// Snapshot: fetch existing events
				const existingEvents = store.queryEvents(params.sessionId, afterSeq)

				const stream = toStreamGenerator<SessionEvent>(
					request,
					sseState,
					listener => store.subscribeToSession(params.sessionId, listener),
					event => ({ event: `append`, data: event.event }),
					{ event: `snapshot`, data: existingEvents }
				)

				return sse(stream)
			},
			{
				params: sessionParamsSchema,
				query: afterSeqQuerySchema
			}
		)
}
