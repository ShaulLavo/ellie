import {
	agentAbortInputSchema,
	agentAbortOutputSchema,
	agentHistoryOutputSchema,
	agentSteerInputSchema,
	agentSteerOutputSchema
} from '@ellie/schemas/agent'
import { Elysia, sse } from 'elysia'
import type { AgentManager } from '../agent/manager'
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

export function createAgentRoutes(
	store: RealtimeStore,
	getAgentManager: () => Promise<AgentManager | null>,
	sseState: SseState
) {
	return new Elysia({ prefix: '/agent', tags: ['Agent'] })
		.get(
			'/:sessionId/messages',
			({ params }) => {
				return store.listAgentMessages(params.sessionId)
			},
			{
				params: sessionParamsSchema
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
				return store.queryRunEvents(
					params.sessionId,
					params.runId
				)
			},
			{
				params: sessionRunParamsSchema
			}
		)
		.get(
			'/:sessionId/events/:runId/sse',
			({ params, request }) => {
				const { sessionId, runId } = params

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
				const agentManager = await getAgentManager()
				if (!agentManager) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				const message = parseAgentActionBody(body)
				agentManager.steer(params.sessionId, message)
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
				const agentManager = await getAgentManager()
				if (!agentManager) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				agentManager.abort(params.sessionId)
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
				const agentManager = await getAgentManager()
				if (!agentManager) {
					set.status = 503
					return {
						error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured`
					}
				}

				return {
					messages: agentManager.loadHistory(
						params.sessionId
					)
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
