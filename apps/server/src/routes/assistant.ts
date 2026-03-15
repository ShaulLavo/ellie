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

const assistantCurrentResponseSchema = v.object({
	threadId: v.string(),
	branchId: v.string()
})

const createThreadInputSchema = v.object({
	agentId: v.string(),
	agentType: v.string(),
	workspaceId: v.string(),
	title: v.optional(v.string())
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
						return { threadId: '', branchId: '' }
					}
					return result
				},
				{
					response: assistantCurrentResponseSchema
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
						body.title
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
