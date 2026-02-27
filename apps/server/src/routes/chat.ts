import { Elysia, sse } from 'elysia'
import * as v from 'valibot'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentController } from '../agent/controller'
import {
	sessionParamsSchema,
	afterSeqQuerySchema,
	errorSchema,
	messageInputSchema,
	normalizeMessageInput,
	toStreamGenerator,
	type SseState
} from './common'

export interface ChatRouteDeps {
	store: RealtimeStore
	sseState: SseState
	getAgentController?: () => Promise<AgentController | null>
	/** Called before the first user message to inject bootstrap events */
	ensureBootstrap?: (sessionId: string) => void
}

/** Resolve the virtual 'current' session ID to the actual one. */
function resolveSessionId(
	store: RealtimeStore,
	raw: string
): string {
	return raw === 'current'
		? store.getCurrentSessionId()
		: raw
}

export function createChatRoutes(
	store: RealtimeStore,
	sseState: SseState,
	getAgentController?: () => Promise<AgentController | null>,
	ensureBootstrap?: (sessionId: string) => void
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
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const session =
						store.eventStore.getSession(sessionId)
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
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					return store.listAgentMessages(sessionId)
				},
				{ params: sessionParamsSchema }
			)

			.post(
				'/:sessionId/messages',
				async ({ params, body }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const input = normalizeMessageInput(body)
					console.log(
						`[chat-route] POST /chat/${sessionId}/messages role=${input.role ?? 'user'} content=${input.content.slice(0, 100)}`
					)
					store.ensureSession(sessionId)
					ensureBootstrap?.(sessionId)
					const controller = await getAgentController?.()
					controller?.watch(sessionId)
					const row = store.appendEvent(
						sessionId,
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
				{ params: sessionParamsSchema }
			)
	)
}
