import {
	agentAbortInputSchema,
	agentAbortOutputSchema,
	agentHistoryOutputSchema,
	agentSteerInputSchema,
	agentSteerOutputSchema
} from '@ellie/schemas/agent'
import { Elysia, sse } from 'elysia'
import type { AgentController } from '../agent/controller'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import {
	sessionParamsSchema,
	sessionRunParamsSchema,
	afterSeqQuerySchema,
	errorSchema,
	parseAgentActionBody,
	toStreamGenerator,
	type SseState
} from './common'

/** Resolve the virtual 'current' session ID to the actual one. */
function resolveSessionId(
	store: RealtimeStore,
	raw: string
): string {
	return raw === 'current'
		? store.getCurrentSessionId()
		: raw
}

export function createAgentRoutes(
	store: RealtimeStore,
	getAgentController: () => Promise<AgentController | null>,
	sseState: SseState
) {
	return new Elysia({ prefix: '/agent', tags: ['Agent'] })
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
				params: sessionParamsSchema
			}
		)
		.get(
			'/:sessionId/events/sse',
			({ params, query, request }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const afterSeq = query.afterSeq
				const existingEvents = store.queryEvents(
					sessionId,
					afterSeq
				)

				const stream = toStreamGenerator<SessionEvent>(
					request,
					sseState,
					listener =>
						store.subscribeToSession(sessionId, listener),
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
		.get(
			'/:sessionId/events/:runId',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				return store.queryRunEvents(sessionId, params.runId)
			},
			{
				params: sessionRunParamsSchema
			}
		)
		.get(
			'/:sessionId/events/:runId/sse',
			({ params, request }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const { runId } = params

				const stream = toStreamGenerator<SessionEvent>(
					request,
					sseState,
					listener =>
						store.subscribeToSession(sessionId, event => {
							// Filter: only forward events for this run
							if (event.event.runId !== runId) return
							listener(event)
						}),
					event => {
						if (event.event.type === 'run_closed') {
							return {
								event: 'closed',
								data: null,
								close: true
							}
						}
						return {
							event: 'append',
							data: event.event
						}
					},
					{
						event: 'snapshot',
						data: store.queryRunEvents(sessionId, runId)
					}
				)

				return sse(stream)
			},
			{
				params: sessionRunParamsSchema
			}
		)
		.post(
			'/:sessionId/steer',
			async ({ params, body, set }) => {
				const controller = await getAgentController()
				if (!controller) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const message = parseAgentActionBody(body)
				controller.steer(sessionId, message)
				return { status: `queued` as const }
			},
			{
				params: sessionParamsSchema,
				body: agentSteerInputSchema,
				response: {
					200: agentSteerOutputSchema,
					400: errorSchema,
					503: errorSchema
				}
			}
		)
		.post(
			'/:sessionId/abort',
			async ({ params, set }) => {
				const controller = await getAgentController()
				if (!controller) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				controller.abort(sessionId)
				return { status: `aborted` as const }
			},
			{
				params: sessionParamsSchema,
				body: agentAbortInputSchema,
				response: {
					200: agentAbortOutputSchema,
					503: errorSchema
				}
			}
		)
		.get(
			'/:sessionId/history',
			async ({ params, set }) => {
				const controller = await getAgentController()
				if (!controller) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				return {
					messages: controller.loadHistory(sessionId)
				}
			},
			{
				params: sessionParamsSchema,
				response: {
					200: agentHistoryOutputSchema,
					503: errorSchema
				}
			}
		)
}
