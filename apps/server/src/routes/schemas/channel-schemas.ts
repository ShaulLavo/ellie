import * as v from 'valibot'

const channelRuntimeStatusSchema = v.object({
	state: v.picklist([
		'disconnected',
		'connecting',
		'connected',
		'error'
	]),
	detail: v.optional(v.string()),
	error: v.optional(v.string()),
	connectedAt: v.optional(v.number()),
	reconnectAttempts: v.optional(v.number(), 0),
	lastConnectedAt: v.optional(v.number()),
	lastDisconnect: v.optional(v.string()),
	lastMessageAt: v.optional(v.number()),
	lastEventAt: v.optional(v.number()),
	lastError: v.optional(v.string()),
	selfId: v.optional(v.string())
})

const channelListItemSchema = v.object({
	id: v.string(),
	displayName: v.string(),
	status: channelRuntimeStatusSchema
})

export const channelListResponseSchema = v.array(
	channelListItemSchema
)

export const channelStatusResponseSchema = v.object({
	id: v.string(),
	displayName: v.string(),
	accounts: v.array(
		v.object({
			accountId: v.string(),
			status: channelRuntimeStatusSchema,
			settings: v.optional(
				v.record(v.string(), v.unknown())
			)
		})
	)
})

export const channelLoginStartBodySchema = v.object({
	accountId: v.pipe(v.string(), v.nonEmpty()),
	settings: v.record(v.string(), v.unknown())
})

export const channelLoginWaitBodySchema = v.object({
	accountId: v.pipe(v.string(), v.nonEmpty())
})

export const channelSettingsBodySchema = v.object({
	accountId: v.pipe(v.string(), v.nonEmpty()),
	settings: v.record(v.string(), v.unknown())
})

export const channelLogoutBodySchema = v.object({
	accountId: v.pipe(v.string(), v.nonEmpty())
})

export const channelIdParamsSchema = v.object({
	channelId: v.pipe(v.string(), v.nonEmpty())
})
