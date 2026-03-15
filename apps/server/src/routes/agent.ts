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
	BranchEvent
} from '../lib/realtime-store'
import {
	branchParamsSchema,
	branchRunParamsSchema,
	parseAgentActionBody,
	requireController,
	resolveBranchId,
	toStreamGenerator,
	type SseState
} from './common'
import { errorSchema } from './schemas/common-schemas'
import { requireLoopback } from './loopback-guard'

function createRunSseStream(
	store: RealtimeStore,
	sseState: SseState,
	branchId: string,
	runId: string,
	request: Request
) {
	return toStreamGenerator<BranchEvent>(
		request,
		sseState,
		listener =>
			store.subscribeToBranch(branchId, event => {
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
			data: store.queryRunEvents(branchId, runId)
		}
	)
}

interface AgentRoutesDeps {
	store: RealtimeStore
	getAgentController: () => Promise<AgentController | null>
	sseState: SseState
}

export function createAgentRoutes(deps: AgentRoutesDeps) {
	const { store, getAgentController, sseState } = deps
	return new Elysia({
		prefix: '/api/agent',
		tags: ['Agent']
	})
		.onBeforeHandle(requireLoopback)
		.get(
			'/:branchId/events/:runId',
			({ params }) => {
				const branchId = resolveBranchId(
					store,
					params.branchId
				)
				return store.queryRunEvents(branchId, params.runId)
			},
			{ params: branchRunParamsSchema }
		)
		.get(
			'/:branchId/events/:runId/sse',
			({ params, request }) => {
				const branchId = resolveBranchId(
					store,
					params.branchId
				)
				return sse(
					createRunSseStream(
						store,
						sseState,
						branchId,
						params.runId,
						request
					)
				)
			},
			{ params: branchRunParamsSchema }
		)
		.post(
			'/:branchId/steer',
			async ({ params, body }) => {
				const controller = await requireController(
					getAgentController
				)

				const branchId = resolveBranchId(
					store,
					params.branchId
				)
				const message = parseAgentActionBody(body)
				controller.steer(branchId, message)
				return { status: `queued` as const }
			},
			{
				params: branchParamsSchema,
				body: agentSteerInputSchema,
				response: {
					200: agentSteerOutputSchema,
					400: errorSchema,
					503: errorSchema
				}
			}
		)
		.post(
			'/:branchId/abort',
			async ({ params }) => {
				const controller = await requireController(
					getAgentController
				)

				const branchId = resolveBranchId(
					store,
					params.branchId
				)
				controller.abort(branchId)
				return { status: `aborted` as const }
			},
			{
				params: branchParamsSchema,
				body: agentAbortInputSchema,
				response: {
					200: agentAbortOutputSchema,
					400: errorSchema,
					503: errorSchema
				}
			}
		)
		.get(
			'/:branchId/history',
			async ({ params }) => {
				const controller = await requireController(
					getAgentController
				)

				const branchId = resolveBranchId(
					store,
					params.branchId
				)
				return {
					messages: controller.loadHistory(branchId)
				}
			},
			{
				params: branchParamsSchema,
				response: {
					200: agentHistoryOutputSchema,
					503: errorSchema
				}
			}
		)
}
