/**
 * Channel routes — generic channel management API.
 *
 * All endpoints are under /api/channels. The CLI calls these routes
 * for WhatsApp setup; future channel providers use the same endpoints.
 */

import { Elysia } from 'elysia'
import type { ChannelManager } from '../channels/core'
import { errorSchema } from './schemas/common-schemas'
import {
	channelListResponseSchema,
	channelStatusResponseSchema,
	channelLoginStartBodySchema,
	channelLoginWaitBodySchema,
	channelSettingsBodySchema,
	channelLogoutBodySchema,
	channelIdParamsSchema
} from './schemas/channel-schemas'
import { NotFoundError } from './http-errors'

export function createChannelRoutes(
	channelManager: ChannelManager
) {
	return new Elysia({
		prefix: '/api/channels',
		tags: ['Channels']
	})

		.get(
			'',
			() => {
				return channelManager
					.listProviders()
					.map(p => ({
						id: p.id,
						displayName: p.displayName,
						status: p.getStatus('default')
					}))
			},
			{
				response: { 200: channelListResponseSchema }
			}
		)

		.get(
			'/:channelId/status',
			({ params }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				const accounts =
					channelManager.listSavedAccounts(
						params.channelId
					)
				// Always include "default" even if no settings yet
				const accountIds =
					accounts.length > 0
						? accounts
						: ['default']
				return {
					id: provider.id,
					displayName: provider.displayName,
					accounts: accountIds.map(accountId => ({
						accountId,
						status: provider.getStatus(accountId),
						settings:
							channelManager.loadSettings(
								params.channelId,
								accountId
							) ?? undefined
					}))
				}
			},
			{
				params: channelIdParamsSchema,
				response: {
					200: channelStatusResponseSchema,
					404: errorSchema
				}
			}
		)

		.post(
			'/:channelId/login/start',
			async ({ params, body }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				// Save settings before starting login
				channelManager.saveSettings(
					params.channelId,
					body.accountId,
					body.settings
				)
				const result = await provider.loginStart(
					body.accountId,
					body.settings
				)
				return result as Record<string, unknown>
			},
			{
				params: channelIdParamsSchema,
				body: channelLoginStartBodySchema,
				response: { 404: errorSchema }
			}
		)

		.post(
			'/:channelId/login/wait',
			async ({ params, body }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				const result = await provider.loginWait(
					body.accountId
				)
				return result as Record<string, unknown>
			},
			{
				params: channelIdParamsSchema,
				body: channelLoginWaitBodySchema,
				response: { 404: errorSchema }
			}
		)

		.post(
			'/:channelId/settings',
			({ params, body }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				channelManager.saveSettings(
					params.channelId,
					body.accountId,
					body.settings
				)
				provider.updateSettings(
					body.accountId,
					body.settings
				)
				return { ok: true }
			},
			{
				params: channelIdParamsSchema,
				body: channelSettingsBodySchema,
				response: { 404: errorSchema }
			}
		)

		.post(
			'/:channelId/logout',
			async ({ params, body }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				await provider.logout(body.accountId)
				channelManager.deleteAccountData(
					params.channelId,
					body.accountId
				)
				return { ok: true }
			},
			{
				params: channelIdParamsSchema,
				body: channelLogoutBodySchema,
				response: { 404: errorSchema }
			}
		)
}
