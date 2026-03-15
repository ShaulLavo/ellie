import * as v from 'valibot'

export const threadSchema = v.object({
	id: v.string(),
	agentId: v.string(),
	agentType: v.string(),
	workspaceId: v.string(),
	title: v.nullable(v.string()),
	state: v.string(),
	dayKey: v.nullable(v.string()),
	originThreadId: v.nullable(v.string()),
	originBranchId: v.nullable(v.string()),
	originRunId: v.nullable(v.string()),
	originAgentId: v.nullable(v.string()),
	createdAt: v.number(),
	updatedAt: v.number()
})

export const threadListSchema = v.array(threadSchema)

export const branchSchema = v.object({
	id: v.string(),
	threadId: v.string(),
	parentBranchId: v.nullable(v.string()),
	forkedFromEventId: v.nullable(v.number()),
	forkedFromSeq: v.nullable(v.number()),
	currentSeq: v.number(),
	createdAt: v.number(),
	updatedAt: v.number()
})

export const branchListSchema = v.array(branchSchema)

const eventRowSchema = v.object({
	id: v.number(),
	branchId: v.string(),
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
	branchId: v.string(),
	runId: v.optional(v.string()),
	traceId: v.optional(v.string()),
	routed: v.optional(
		v.picklist(['prompt', 'followUp', 'queued'])
	),
	deduplicated: v.optional(v.boolean())
})

export const clearBranchResponseSchema = v.object({
	threadId: v.string(),
	branchId: v.string(),
	previousThreadId: v.string()
})
