import { Elysia } from 'elysia'
import * as v from 'valibot'
import type { RealtimeStore } from '../lib/realtime-store'

const sessionCurrentResponseSchema = v.object({
	sessionId: v.string()
})

export function createSessionRoutes(store: RealtimeStore) {
	return new Elysia({
		prefix: '/api',
		tags: ['Session']
	}).get(
		'/session/current',
		() => {
			return { sessionId: store.getCurrentSessionId() }
		},
		{
			response: sessionCurrentResponseSchema
		}
	)
}
