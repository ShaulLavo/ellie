/**
 * Assistant routes — current assistant thread/branch lookup,
 * thread CRUD, and assistant-current SSE.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia, sse } from 'elysia'
import * as v from 'valibot'
import type { RealtimeStore } from '../lib/realtime-store'
import { requireLoopback } from './loopback-guard'
import {
	threadSchema,
	threadListSchema,
	branchListSchema
} from './schemas/chat-schemas'
import { errorSchema } from './schemas/common-schemas'
import { toStreamGenerator, type SseState } from './common'
import { NotFoundError } from './http-errors'
import { todayDayKey } from '../init'

const assistantCurrentResponseSchema = v.object({
	threadId: v.string(),
	branchId: v.string()
})

const originSchema = v.optional(
	v.object({
		threadId: v.optional(v.string()),
		branchId: v.optional(v.string()),
		runId: v.optional(v.string()),
		agentId: v.optional(v.string())
	})
)

const createThreadInputSchema = v.object({
	agentId: v.string(),
	agentType: v.string(),
	workspaceId: v.string(),
	title: v.optional(v.string()),
	origin: originSchema
})

const createThreadResponseSchema = v.object({
	threadId: v.string(),
	branchId: v.string()
})

const threadParamsSchema = v.object({
	threadId: v.string()
})

export function createAssistantRoutes(
	store: RealtimeStore,
	sseState: SseState
) {
	return (
		new Elysia({
			prefix: '/api',
			tags: ['Assistant']
		})
			.onBeforeHandle(requireLoopback)

			// GET /api/assistant/current
			.get(
				'/assistant/current',
				() => {
					const result = store.getDefaultAssistantThread()
					if (!result) {
						throw new NotFoundError(
							'No default assistant thread configured'
						)
					}
					return result
				},
				{
					response: {
						200: assistantCurrentResponseSchema,
						404: errorSchema
					}
				}
			)

			// POST /api/assistant/new — rotate to a new assistant thread
			.post(
				'/assistant/new',
				() => {
					return store.rotateAssistantThread(
						'assistant',
						'main',
						todayDayKey()
					)
				},
				{
					response: {
						200: createThreadResponseSchema
					}
				}
			)

			// GET /api/assistant/current/sse
			.get('/assistant/current/sse', ({ request }) => {
				const stream = toStreamGenerator(
					request,
					sseState,
					listener =>
						store.subscribeToAssistantChange(listener),
					event => ({
						event: 'assistant-change',
						data: event
					}),
					{
						event: 'connected',
						data: store.getDefaultAssistantThread() ?? {
							threadId: '',
							branchId: ''
						}
					}
				)
				return sse(stream)
			})

			// GET /api/threads
			.get('/threads', () => store.listThreads(), {
				response: threadListSchema
			})

			// POST /api/threads
			.post(
				'/threads',
				({ body }) => {
					return store.createThreadWithBranch(
						body.agentId,
						body.agentType,
						body.workspaceId,
						body.title,
						body.origin
					)
				},
				{
					body: createThreadInputSchema,
					response: {
						200: createThreadResponseSchema
					}
				}
			)

			// GET /api/threads/:threadId
			.get(
				'/threads/:threadId',
				({ params }) => {
					const thread = store.getThread(params.threadId)
					if (!thread) {
						throw new NotFoundError('Thread not found')
					}
					return thread
				},
				{
					params: threadParamsSchema,
					response: {
						200: threadSchema,
						404: errorSchema
					}
				}
			)

			// GET /api/threads/:threadId/branches
			.get(
				'/threads/:threadId/branches',
				({ params }) => {
					const thread = store.getThread(params.threadId)
					if (!thread) {
						throw new NotFoundError('Thread not found')
					}
					return store.listBranches(params.threadId)
				},
				{
					params: threadParamsSchema,
					response: {
						200: branchListSchema,
						404: errorSchema
					}
				}
			)
	)
}
