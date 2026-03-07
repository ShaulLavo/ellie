/**
 * Chat routes — sessions, messages, and SSE event streams.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia, sse } from 'elysia'
import { hash } from 'ohash'
import * as v from 'valibot'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentController } from '../agent/controller'
import {
	agentMessageSchema,
	type UserMessage
} from '@ellie/schemas/agent'
import {
	sessionParamsSchema,
	afterSeqQuerySchema,
	eventsQuerySchema,
	messageInputSchema,
	normalizeMessageInput,
	resolveSessionId,
	toStreamGenerator,
	type SseState
} from './common'
import { errorSchema } from './schemas/common-schemas'
import {
	sessionSchema,
	sessionListSchema,
	eventRowListSchema,
	postMessageResponseSchema,
	clearSessionResponseSchema
} from './schemas/chat-schemas'
import {
	BadRequestError,
	NotFoundError
} from './http-errors'
import type { FileStore } from '@ellie/tus'

/** Read a TUS upload into a Buffer. */
async function readUploadBytes(
	uploadStore: FileStore,
	uploadId: string
): Promise<Buffer> {
	const stream = uploadStore.read(uploadId)
	const chunks: Uint8Array[] = []
	for await (const chunk of stream) {
		chunks.push(
			chunk instanceof Uint8Array
				? chunk
				: new Uint8Array(chunk as ArrayBuffer)
		)
	}
	return Buffer.concat(chunks)
}

/** Check if a MIME type represents text-based content the model can read. */
const TEXT_MIME_PREFIXES = [
	'text/',
	'application/json',
	'application/xml',
	'application/javascript',
	'application/typescript',
	'application/x-yaml',
	'application/toml',
	'application/sql'
]

/** Extensions browsers commonly misidentify (e.g. .ts → video/mp2t). */
const TEXT_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.yaml',
	'.yml',
	'.toml',
	'.xml',
	'.md',
	'.mdx',
	'.txt',
	'.csv',
	'.tsv',
	'.html',
	'.htm',
	'.css',
	'.scss',
	'.less',
	'.py',
	'.rb',
	'.rs',
	'.go',
	'.java',
	'.kt',
	'.c',
	'.h',
	'.cpp',
	'.hpp',
	'.cs',
	'.swift',
	'.sh',
	'.bash',
	'.zsh',
	'.fish',
	'.sql',
	'.graphql',
	'.gql',
	'.env',
	'.ini',
	'.cfg',
	'.conf',
	'.vue',
	'.svelte',
	'.astro'
])

function isTextContent(
	mime: string,
	filename?: string
): boolean {
	if (TEXT_MIME_PREFIXES.some(p => mime.startsWith(p)))
		return true
	if (filename) {
		const ext = filename
			.slice(filename.lastIndexOf('.'))
			.toLowerCase()
		if (TEXT_EXTENSIONS.has(ext)) return true
	}
	return false
}

export function createChatRoutes(
	store: RealtimeStore,
	sseState: SseState,
	getAgentController?: () => Promise<AgentController | null>,
	ensureBootstrap?: (sessionId: string) => void,
	uploadStore?: FileStore
) {
	return (
		new Elysia({ prefix: '/chat', tags: ['Chat'] })

			// ── Sessions CRUD ───────────────────────────────────────────────

			.post(
				'/sessions',
				() => {
					const session = store.createSession()
					return session
				},
				{
					response: { 200: sessionSchema }
				}
			)

			.get(
				'/sessions',
				() => {
					return store.listSessions()
				},
				{
					response: { 200: sessionListSchema }
				}
			)

			.get(
				'/sessions/:sessionId',
				({ params }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const session = store.getSession(sessionId)
					if (!session) {
						throw new NotFoundError('Session not found')
					}
					return session
				},
				{
					params: sessionParamsSchema,
					response: {
						200: sessionSchema,
						404: errorSchema
					}
				}
			)

			// ── Messages ────────────────────────────────────────────────────

			.get(
				'/:sessionId/messages',
				({ params }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					return store.listAgentMessages(sessionId)
				},
				{
					params: sessionParamsSchema,
					response: {
						200: v.array(agentMessageSchema)
					}
				}
			)

			.post(
				'/:sessionId/messages',
				async ({ params, body }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const input = normalizeMessageInput(body)
					store.ensureSession(sessionId)

					// Build content parts: text + attachments
					const contentParts: UserMessage['content'] = []
					const trimmed = input.content.trim()
					if (trimmed) {
						contentParts.push({
							type: 'text',
							text: trimmed
						})
					}
					if (input.attachments && uploadStore) {
						for (const att of input.attachments) {
							const mime = att.mime
							if (mime.startsWith('image/')) {
								// Read image data as base64 so the model can see it
								const bytes = await readUploadBytes(
									uploadStore,
									att.uploadId
								)
								contentParts.push({
									type: 'image',
									file: att.uploadId,
									mime: att.mime,
									size: att.size,
									name: att.name,
									data: bytes.toString('base64'),
									mimeType: att.mime
								})
							} else if (isTextContent(mime, att.name)) {
								// Store as file attachment (renders as card in UI)
								// but embed textContent so the model can read it
								const bytes = await readUploadBytes(
									uploadStore,
									att.uploadId
								)
								const textContent =
									new TextDecoder().decode(bytes)
								contentParts.push({
									type: 'file',
									file: att.uploadId,
									mime: att.mime,
									size: att.size,
									name: att.name,
									textContent
								})
							} else if (mime.startsWith('video/')) {
								contentParts.push({
									type: 'video',
									file: att.uploadId,
									mime: att.mime,
									size: att.size,
									name: att.name
								})
							} else if (mime.startsWith('audio/')) {
								contentParts.push({
									type: 'audio',
									file: att.uploadId,
									mime: att.mime,
									size: att.size,
									name: att.name
								})
							} else {
								contentParts.push({
									type: 'file',
									file: att.uploadId,
									mime: att.mime,
									size: att.size,
									name: att.name
								})
							}
						}
					}

					// Persist user message BEFORE bootstrap so the client
					// sees the user bubble first, then the synthetic tool call.
					// Dedupe key: reject rapid-fire duplicate POSTs with the
					// same content (e.g. key repeat on Enter). Window ~ 2s.
					const dedupeWindow = Math.floor(Date.now() / 2000)
					const contentHash = hash(input.content)
					const dedupeKey = `user_msg:${sessionId}:${dedupeWindow}:${contentHash}`

					const beforeAppend = Date.now()
					const row = store.appendEvent(
						sessionId,
						'user_message',
						{
							role: 'user',
							content: contentParts,
							timestamp: beforeAppend
						},
						undefined, // runId — backfilled later by controller
						dedupeKey
					)

					// Dedupe hit: appendEvent returned an existing row
					// (createdAt will be older than our beforeAppend timestamp)
					if (row.createdAt < beforeAppend) {
						return {
							id: row.id,
							seq: row.seq,
							sessionId: row.sessionId,
							deduplicated: true
						}
					}

					ensureBootstrap?.(sessionId)

					// Route the message directly to the agent controller.
					// handleMessage backfills the runId on the user_message row.
					let result:
						| {
								runId: string
								routed: 'prompt' | 'followUp' | 'queued'
								traceId?: string
						  }
						| undefined
					try {
						const controller = await getAgentController?.()
						result = controller
							? await controller.handleMessage(
									sessionId,
									input.content,
									row.id
								)
							: undefined
					} catch (err) {
						throw new BadRequestError(
							err instanceof Error
								? err.message
								: 'Message routing failed'
						)
					}

					return {
						id: row.id,
						seq: row.seq,
						sessionId: row.sessionId,
						...(result
							? {
									runId: result.runId,
									traceId: result.traceId,
									routed: result.routed
								}
							: {})
					}
				},
				{
					params: sessionParamsSchema,
					body: messageInputSchema,
					response: {
						200: postMessageResponseSchema,
						400: errorSchema
					}
				}
			)

			.delete(
				'/:sessionId/messages',
				({ params }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					store.deleteSession(sessionId)
					return new Response(null, { status: 204 })
				},
				{ params: sessionParamsSchema }
			)

			// ── Events (replay cursor + SSE) ────────────────────────────────

			.get(
				'/:sessionId/events',
				({ params, query }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const afterSeq = query.afterSeq
					const limit = query.limit
						? Number(query.limit)
						: undefined
					return store.queryEvents(
						sessionId,
						afterSeq,
						undefined,
						limit
					)
				},
				{
					params: sessionParamsSchema,
					query: eventsQuerySchema,
					response: { 200: eventRowListSchema }
				}
			)

			.get(
				'/:sessionId/events/sse',
				({ params, query, request }) => {
					const isCurrent = params.sessionId === 'current'
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					const afterSeq = query.afterSeq

					const existingEvents = store.queryEvents(
						sessionId,
						afterSeq
					)

					// For 'current' connections, create a combined abort
					// signal that fires on rotation OR client disconnect.
					// This wakes toStreamGenerator's blocking wait so the
					// client reconnects to the new session.
					let effectiveRequest = request
					let unsubRotation: (() => void) | undefined
					if (isCurrent) {
						const ac = new AbortController()
						const abort = ac.abort.bind(ac)
						request.signal.addEventListener(
							'abort',
							abort,
							{ once: true }
						)
						unsubRotation = store.subscribeToRotation(abort)
						effectiveRequest = new Request(request.url, {
							signal: ac.signal
						})
					}

					const stream = toStreamGenerator<SessionEvent>(
						effectiveRequest,
						sseState,
						listener => {
							const unsubSession = store.subscribeToSession(
								sessionId,
								listener
							)
							// Bundle rotation cleanup with session
							// unsubscribe so both are cleaned up by
							// toStreamGenerator's finally block.
							return () => {
								unsubSession()
								unsubRotation?.()
							}
						},
						event => ({
							event: event.type,
							data: event.event
						}),
						{
							event: 'snapshot',
							data: {
								sessionId,
								events: existingEvents
							}
						}
					)

					return sse(stream)
				},
				{
					params: sessionParamsSchema,
					query: afterSeqQuerySchema
				}
			)

			// ── Session lifecycle ────────────────────────────────────────────

			.post(
				'/:sessionId/clear',
				({ params }) => {
					const sessionId = resolveSessionId(
						store,
						params.sessionId
					)
					store.deleteSession(sessionId)
					const session = store.createSession(sessionId)
					return {
						sessionId: session.id,
						cleared: true
					}
				},
				{
					params: sessionParamsSchema,
					response: {
						200: clearSessionResponseSchema
					}
				}
			)
	)
}
