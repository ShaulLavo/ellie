/**
 * Trace routes — read trace journals and blob content.
 */

import { Elysia } from 'elysia'
import * as v from 'valibot'
import type { TraceRecorder } from '@ellie/trace'
import { errorSchema } from './schemas/common-schemas'
import { NotFoundError } from './http-errors'

const traceIdParamsSchema = v.object({
	traceId: v.string()
})

const sessionIdParamsSchema = v.object({
	sessionId: v.string()
})

export function createTraceRoutes(recorder: TraceRecorder) {
	return new Elysia({
		prefix: '/traces',
		tags: ['Traces']
	})
		.get('/list', () => recorder.listTraces())
		.get(
			'/:traceId/events',
			({ params }) => {
				const events = recorder.readTrace(params.traceId)
				if (events.length === 0) {
					throw new NotFoundError(
						`Trace not found: ${params.traceId}`
					)
				}
				return events
			},
			{
				params: traceIdParamsSchema,
				response: {
					404: errorSchema
				}
			}
		)
		.get(
			'/by-session/:sessionId',
			({ params }) => {
				const traces = recorder.findTracesBySession(
					params.sessionId
				)
				return traces
			},
			{
				params: sessionIdParamsSchema
			}
		)
}
