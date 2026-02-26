import { Elysia } from 'elysia'
import * as v from 'valibot'
import type { RealtimeStore } from '../lib/realtime-store'

function todayDateString(): string {
	const now = new Date()
	const year = now.getFullYear()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

const sessionTodayResponseSchema = v.object({
	sessionId: v.string(),
	date: v.string()
})

export function createSessionRoutes(store: RealtimeStore) {
	return new Elysia({
		prefix: '/api',
		tags: ['Session']
	}).get(
		'/session/today',
		() => {
			const date = todayDateString()
			const sessionId = `session-${date}`
			store.ensureSession(sessionId)
			return { sessionId, date }
		},
		{
			response: sessionTodayResponseSchema
		}
	)
}
