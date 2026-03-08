import * as v from 'valibot'

// ── Channel schemas ─────────────────────────────────────────────────────────

export const channelRuntimeStatusSchema = v.variant('state', [
	v.object({ state: v.literal('disconnected') }),
	v.object({
		state: v.literal('connecting'),
		detail: v.optional(v.string())
	}),
	v.object({
		state: v.literal('connected'),
		connectedAt: v.number()
	}),
	v.object({
		state: v.literal('error'),
		error: v.string()
	})
])

export const channelListItemSchema = v.object({
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
			settings: v.optional(v.record(v.string(), v.unknown()))
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
