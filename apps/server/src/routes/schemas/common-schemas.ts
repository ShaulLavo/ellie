/**
 * Shared parameter, query, and input schemas used across route modules.
 */

import * as v from 'valibot'

export const errorSchema = v.object({ error: v.string() })

const attachmentInputSchema = v.object({
	uploadId: v.string(),
	mime: v.string(),
	size: v.number(),
	name: v.string()
})

export const messageInputSchema = v.object({
	content: v.string(),
	role: v.optional(
		v.picklist([`user`, `assistant`, `system`])
	),
	attachments: v.optional(v.array(attachmentInputSchema)),
	speechRef: v.optional(v.string())
})

export type MessageInput = v.InferOutput<
	typeof messageInputSchema
>

export const sessionParamsSchema = v.object({
	sessionId: v.string()
})
export const sessionRunParamsSchema = v.object({
	sessionId: v.string(),
	runId: v.string()
})
/** Reusable pipe for parsing a non-negative integer from a query string. */
const nonNegativeIntFromString = v.pipe(
	v.string(),
	v.transform(Number),
	v.number(),
	v.finite(),
	v.integer(),
	v.minValue(0)
)

export const afterSeqQuerySchema = v.object({
	afterSeq: v.optional(nonNegativeIntFromString)
})

export const eventsQuerySchema = v.object({
	afterSeq: v.optional(nonNegativeIntFromString),
	limit: v.optional(v.string())
})
export const statusSchema = v.object({
	connectedClients: v.number(),
	needsBootstrap: v.boolean()
})
