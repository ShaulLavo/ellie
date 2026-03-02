import { Elysia } from 'elysia'
import { statusSchema } from './common'

export function createStatusRoutes(
	getConnectedClients: () => number,
	getNeedsBootstrap: () => boolean
) {
	return new Elysia({
		prefix: '/api',
		tags: ['Status']
	}).get(
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
