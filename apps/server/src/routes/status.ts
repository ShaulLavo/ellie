import { Elysia } from 'elysia'
import { statusSchema } from './common'
import { requireLoopback } from './loopback-guard'

export function createStatusRoutes(
	getConnectedClients: () => number,
	getNeedsBootstrap: () => boolean
) {
	return new Elysia({
		prefix: '/api',
		tags: ['Status']
	})
		.onBeforeHandle(requireLoopback)
		.get(
			'/status',
			() => {
				return {
					connectedClients: getConnectedClients(),
					needsBootstrap: getNeedsBootstrap()
				}
			},
			{
				response: statusSchema
			}
		)
}
