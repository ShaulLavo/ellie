import { Elysia, sse } from 'elysia'
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
	return new Elysia({ prefix: '/chat', tags: ['Chat'] })
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
			async ({ params, body }) => {
				const input = normalizeMessageInput(body)
				console.log(
					`[chat-route] POST /chat/${params.sessionId}/messages role=${input.role ?? 'user'} content=${input.content.slice(0, 100)}`
				)
				store.ensureSession(params.sessionId)
				// Subscribe the watcher BEFORE appending so it
				// picks up the event via the synchronous publish.
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
