import { Elysia, sse } from 'elysia'
import * as v from 'valibot'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentWatcher } from '../agent/watcher'
import {
	sessionParamsSchema,
	afterSeqQuerySchema,
	errorSchema,
	messageInputSchema,
	normalizeMessageInput,
	toStreamGenerator,
	type SseState
} from './common'

export function createChatRoutes(
	store: RealtimeStore,
	sseState: SseState,
	getAgentWatcher?: () => Promise<AgentWatcher | null>
) {
	return (
		new Elysia({ prefix: '/chat', tags: ['Chat'] })

			// ── Sessions CRUD ───────────────────────────────────────────────

			.post('/sessions', () => {
				const session = store.createSession()
				return session
			})

			.get('/sessions', () => {
				return store.listSessions()
			})

			.get(
				'/sessions/:sessionId',
				({ params, set }) => {
					const session = store.eventStore.getSession(
						params.sessionId
					)
					if (!session) {
						set.status = 404
						return { error: 'Session not found' }
					}
					return session
				},
				{
					params: sessionParamsSchema,
					response: { 404: errorSchema }
				}
			)

			// ── Messages ────────────────────────────────────────────────────

			.get(
				'/:sessionId/messages',
				({ params }) => {
					return store.listAgentMessages(params.sessionId)
				},
				{ params: sessionParamsSchema }
			)

			.post(
				'/:sessionId/messages',
				async ({ params, body }) => {
					const input = normalizeMessageInput(body)
					console.log(
						`[chat-route] POST /chat/${params.sessionId}/messages role=${input.role ?? 'user'} content=${input.content.slice(0, 100)}`
					)
					store.ensureSession(params.sessionId)
					const agentWatcher = await getAgentWatcher?.()
					agentWatcher?.watch(params.sessionId)
					const row = store.appendEvent(
						params.sessionId,
						'user_message',
						{
							role: input.role ?? 'user',
							content: [
								{ type: 'text', text: input.content }
							],
							timestamp: Date.now()
						}
					)
					console.log(
						`[chat-route] user_message persisted id=${row.id} seq=${row.seq} session=${row.sessionId}`
					)
					return {
						id: row.id,
						seq: row.seq,
						sessionId: row.sessionId
					}
				},
				{
					params: sessionParamsSchema,
					body: messageInputSchema,
					response: { 400: errorSchema }
				}
			)

			.delete(
				'/:sessionId/messages',
				({ params }) => {
					store.deleteSession(params.sessionId)
					return new Response(null, { status: 204 })
				},
				{ params: sessionParamsSchema }
			)

			// ── Events (replay cursor + SSE) ────────────────────────────────

			.get(
				'/:sessionId/events',
				({ params, query }) => {
					const afterSeq = query.afterSeq
					const limit = query.limit
						? Number(query.limit)
						: undefined
					return store.queryEvents(
						params.sessionId,
						afterSeq,
						undefined,
						limit
					)
				},
				{
					params: sessionParamsSchema,
					query: v.object({
						afterSeq: v.optional(
							v.pipe(
								v.string(),
								v.transform(Number),
								v.number(),
								v.finite(),
								v.integer(),
								v.minValue(0)
							)
						),
						limit: v.optional(v.string())
					})
				}
			)

			.get(
				'/:sessionId/events/sse',
				({ params, query, request }) => {
					const afterSeq = query.afterSeq

					const existingEvents = store.queryEvents(
						params.sessionId,
						afterSeq
					)

					const stream = toStreamGenerator<SessionEvent>(
						request,
						sseState,
						listener =>
							store.subscribeToSession(
								params.sessionId,
								listener
							),
						event => ({
							event: 'append',
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
					store.deleteSession(params.sessionId)
					const session = store.createSession(
						params.sessionId
					)
					return {
						sessionId: session.id,
						cleared: true
					}
				},
				{ params: sessionParamsSchema }
			)
	)
}
