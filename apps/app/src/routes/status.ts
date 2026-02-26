import { Elysia } from 'elysia'
import { statusSchema } from './common'

export function createStatusRoutes(
	getConnectedClients: () => number
) {
	return new Elysia({
		prefix: '/api',
		tags: ['Status']
	}).get(
		'/status',
		() => {
			return {
				connectedClients: getConnectedClients()
			}
		},
		{
			response: statusSchema
		}
	)
}
