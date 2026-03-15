import * as v from 'valibot'

export const sessionSchema = v.object({
	id: v.string(),
	createdAt: v.number(),
	updatedAt: v.number(),
	currentSeq: v.number()
})

export const sessionListSchema = v.array(sessionSchema)

const eventRowSchema = v.object({
	id: v.number(),
	sessionId: v.string(),
	seq: v.number(),
	runId: v.nullable(v.string()),
	type: v.string(),
	payload: v.string(),
	dedupeKey: v.nullable(v.string()),
	createdAt: v.number()
})

export const eventRowListSchema = v.array(eventRowSchema)

export const postMessageResponseSchema = v.object({
	id: v.number(),
	seq: v.number(),
	sessionId: v.string(),
	runId: v.optional(v.string()),
	traceId: v.optional(v.string()),
	routed: v.optional(
		v.picklist(['prompt', 'followUp', 'queued'])
	),
	deduplicated: v.optional(v.boolean())
})

export const clearSessionResponseSchema = v.object({
	sessionId: v.string(),
	cleared: v.literal(true)
})
