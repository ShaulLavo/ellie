/**
 * Session routes — current session lookup.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia } from 'elysia'
import * as v from 'valibot'
import type { RealtimeStore } from '../lib/realtime-store'
import { requireLoopback } from './loopback-guard'

const sessionCurrentResponseSchema = v.object({
	sessionId: v.string()
})

export function createSessionRoutes(store: RealtimeStore) {
	return new Elysia({
		prefix: '/api',
		tags: ['Session']
	})
		.onBeforeHandle(requireLoopback)
		.get(
			'/session/current',
			() => {
				return { sessionId: store.getCurrentSessionId() }
			},
			{
				response: sessionCurrentResponseSchema
			}
		)
}
