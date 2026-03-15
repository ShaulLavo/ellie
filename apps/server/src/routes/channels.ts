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
import {
	NotFoundError,
	BadRequestError
} from './http-errors'
import * as v from 'valibot'
import { whatsappSettingsSchema } from '../channels/providers/whatsapp/settings-schema'
import {
	listPairingRequests,
	approvePairingCode
} from '../channels/providers/whatsapp/pairing-store'
import {
	readAllowFrom,
	addAllowFrom,
	removeAllowFrom,
	mergedAllowFrom
} from '../channels/providers/whatsapp/allowfrom-store'
import { normalizeE164 } from '../channels/providers/whatsapp/normalize'
import type { WhatsAppSettings } from '../channels/providers/whatsapp/provider'
import { requireLoopback } from './loopback-guard'

/** Validate and normalize WhatsApp settings, returning validated+defaulted output. */
function validateWhatsAppSettings(
	settings: Record<string, unknown>
): Record<string, unknown> {
	const result = v.safeParse(
		whatsappSettingsSchema,
		settings
	)
	if (!result.success) {
		throw new BadRequestError(
			`Invalid WhatsApp settings: ${result.issues.map(i => i.message).join(', ')}`
		)
	}
	return result.output as Record<string, unknown>
}

export function createChannelRoutes(
	channelManager: ChannelManager
) {
	return new Elysia({
		prefix: '/api/channels',
		tags: ['Channels']
	})
		.onBeforeHandle(requireLoopback)

		.get(
			'',
			() => {
				return channelManager.listProviders().map(p => ({
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
			async ({ params }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				const accounts = channelManager.listSavedAccounts(
					params.channelId
				)
				// Always include "default" even if no settings yet
				const accountIds =
					accounts.length > 0 ? accounts : ['default']
				return {
					id: provider.id,
					displayName: provider.displayName,
					accounts: await Promise.all(
						accountIds.map(async accountId => ({
							accountId,
							status: provider.getStatus(accountId),
							settings:
								(await channelManager.loadSettings(
									params.channelId,
									accountId
								)) ?? undefined
						}))
					)
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
				// Validate and normalize settings for WhatsApp
				const settings =
					params.channelId === 'whatsapp'
						? validateWhatsAppSettings(body.settings)
						: body.settings
				// Save settings before starting login
				await channelManager.saveSettings(
					params.channelId,
					body.accountId,
					settings
				)
				const result = await provider.loginStart(
					body.accountId,
					settings
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
			async ({ params, body }) => {
				const provider = channelManager.getProvider(
					params.channelId
				)
				if (!provider) {
					throw new NotFoundError(
						`Channel not found: ${params.channelId}`
					)
				}
				const settings =
					params.channelId === 'whatsapp'
						? validateWhatsAppSettings(body.settings)
						: body.settings
				await channelManager.saveSettings(
					params.channelId,
					body.accountId,
					settings
				)
				provider.updateSettings(body.accountId, settings)
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

		.get('/whatsapp/pairing/list', ({ query }) => {
			const accountId =
				(query as Record<string, string>).accountId ??
				'default'
			return listPairingRequests({
				dataDir: channelManager.dataDir,
				accountId
			})
		})

		.post(
			'/whatsapp/pairing/approve',
			({ body }) => {
				const { accountId = 'default', code } = body
				const result = approvePairingCode({
					dataDir: channelManager.dataDir,
					accountId,
					code
				})
				if (!result) {
					throw new NotFoundError(
						'No pending request with that code'
					)
				}
				// Add to runtime allowFrom store
				addAllowFrom(
					channelManager.dataDir,
					accountId,
					result.id
				)
				return {
					ok: true,
					senderId: result.id
				}
			},
			{
				body: v.object({
					accountId: v.optional(v.string()),
					code: v.string()
				})
			}
		)

		.get('/whatsapp/allow/list', async ({ query }) => {
			const accountId =
				(query as Record<string, string>).accountId ??
				'default'
			const settings = (await channelManager.loadSettings(
				'whatsapp',
				accountId
			)) as WhatsAppSettings | null
			return {
				config: settings?.allowFrom ?? [],
				runtime: readAllowFrom(
					channelManager.dataDir,
					accountId
				),
				merged: mergedAllowFrom(
					settings?.allowFrom ?? [],
					channelManager.dataDir,
					accountId
				)
			}
		})

		.post(
			'/whatsapp/allow/add',
			({ body }) => {
				const { accountId = 'default', number } = body
				const normalized = normalizeE164(number)
				if (!normalized || normalized.length < 2) {
					throw new BadRequestError('Invalid phone number')
				}
				addAllowFrom(
					channelManager.dataDir,
					accountId,
					normalized
				)
				return { ok: true, normalized }
			},
			{
				body: v.object({
					accountId: v.optional(v.string()),
					number: v.string()
				})
			}
		)

		.post(
			'/whatsapp/allow/remove',
			({ body }) => {
				const { accountId = 'default', number } = body
				removeAllowFrom(
					channelManager.dataDir,
					accountId,
					number
				)
				return { ok: true }
			},
			{
				body: v.object({
					accountId: v.optional(v.string()),
					number: v.string()
				})
			}
		)
}
