/**
 * Agent routes — run events, SSE streams, steer, abort, and history.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

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
	parseAgentActionBody,
	requireController,
	resolveSessionId,
	toStreamGenerator,
	type SseState
} from './common'
import { errorSchema } from './schemas/common-schemas'
import { BadRequestError } from './http-errors'

function createRunSseStream(
	store: RealtimeStore,
	sseState: SseState,
	sessionId: string,
	runId: string,
	request: Request
) {
	return toStreamGenerator<SessionEvent>(
		request,
		sseState,
		listener =>
			store.subscribeToSession(sessionId, event => {
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
				event: event.type,
				data: event.event
			}
		},
		{
			event: 'snapshot',
			data: store.queryRunEvents(sessionId, runId)
		}
	)
}

export function createAgentRoutes(
	store: RealtimeStore,
	getAgentController: () => Promise<AgentController | null>,
	sseState: SseState
) {
	return new Elysia({ prefix: '/agent', tags: ['Agent'] })
		.get(
			'/:sessionId/events/:runId',
			({ params }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				return store.queryRunEvents(sessionId, params.runId)
			},
			{ params: sessionRunParamsSchema }
		)
		.get(
			'/:sessionId/events/:runId/sse',
			({ params, request }) => {
				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				return sse(
					createRunSseStream(
						store,
						sseState,
						sessionId,
						params.runId,
						request
					)
				)
			},
			{ params: sessionRunParamsSchema }
		)
		.post(
			'/:sessionId/steer',
			async ({ params, body }) => {
				const controller = await requireController(
					getAgentController
				)

				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				const message = parseAgentActionBody(body)
				try {
					controller.steer(sessionId, message)
				} catch (err) {
					throw new BadRequestError(
						err instanceof Error
							? err.message
							: 'Steer failed'
					)
				}
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
			async ({ params }) => {
				const controller = await requireController(
					getAgentController
				)

				const sessionId = resolveSessionId(
					store,
					params.sessionId
				)
				try {
					controller.abort(sessionId)
				} catch (err) {
					throw new BadRequestError(
						err instanceof Error
							? err.message
							: 'Abort failed'
					)
				}
				return { status: `aborted` as const }
			},
			{
				params: sessionParamsSchema,
				body: agentAbortInputSchema,
				response: {
					200: agentAbortOutputSchema,
					400: errorSchema,
					503: errorSchema
				}
			}
		)
		.get(
			'/:sessionId/history',
			async ({ params }) => {
				const controller = await requireController(
					getAgentController
				)

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
