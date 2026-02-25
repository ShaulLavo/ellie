import { sse } from 'elysia'
import * as v from 'valibot'

export const messageInputSchema = v.object({
	content: v.string(),
	role: v.optional(
		v.picklist([`user`, `assistant`, `system`])
	)
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
export const afterSeqQuerySchema = v.object({
	afterSeq: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.finite(),
			v.integer(),
			v.minValue(0)
		)
	)
})
export const statusSchema = v.object({
	connectedClients: v.number()
})
export const errorSchema = v.object({ error: v.string() })

// ── Auth schemas ─────────────────────────────────────────────────────────────

export const authStatusResponseSchema = v.object({
	mode: v.nullable(
		v.picklist(['api_key', 'token', 'oauth'])
	),
	source: v.picklist([
		'env_api_key',
		'env_token',
		'env_oauth',
		'file',
		'none'
	]),
	configured: v.boolean(),
	expires_at: v.optional(v.number()),
	expired: v.optional(v.boolean()),
	preview: v.optional(v.string())
})

export const authClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const authApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const authApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

export const authTokenBodySchema = v.object({
	token: v.pipe(v.string(), v.nonEmpty()),
	expires: v.optional(v.number())
})

export const authTokenResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('token')
})

export const authOAuthAuthorizeBodySchema = v.object({
	mode: v.picklist(['max', 'console'])
})

export const authOAuthAuthorizeResponseSchema = v.object({
	url: v.string(),
	verifier: v.string(),
	mode: v.picklist(['max', 'console'])
})

export const authOAuthExchangeBodySchema = v.object({
	callback_code: v.pipe(v.string(), v.nonEmpty()),
	verifier: v.pipe(v.string(), v.nonEmpty()),
	mode: v.picklist(['max', 'console'])
})

export const authOAuthExchangeResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.picklist(['oauth', 'api_key']),
	message: v.string()
})

export interface SseState {
	activeClients: number
}

export function normalizeMessageInput(
	body: MessageInput
): MessageInput {
	const content = body.content.trim()
	if (content.length === 0) {
		throw new Error(
			`Missing 'content' field in request body`
		)
	}

	return {
		content,
		role: body.role
	}
}

export function parseAgentActionBody(body: {
	message: string
}): string {
	const value = normalizeMessageInput({
		content: body.message,
		role: undefined
	})

	return value.content
}

export function toStreamGenerator<
	TEvent extends { type: string }
>(
	request: Request,
	sseState: SseState,
	subscribe: (
		listener: (event: TEvent) => void
	) => () => void,
	mapEvent: (event: TEvent) => {
		event: string
		data: unknown
		close?: boolean
	},
	snapshotEvent: { event: string; data: unknown },
	initialEvents: TEvent[] = []
): AsyncGenerator<unknown> {
	return (async function* streamGenerator() {
		sseState.activeClients++

		const queue: TEvent[] = [...initialEvents]
		let resolver: (() => void) | null = null
		let aborted = request.signal.aborted

		const wake = () => {
			if (!resolver) return
			resolver()
			resolver = null
		}

		const onAbort = () => {
			aborted = true
			wake()
		}

		request.signal.addEventListener('abort', onAbort, {
			once: true
		})
		const unsubscribe = subscribe(event => {
			queue.push(event)
			wake()
		})

		try {
			yield sse(snapshotEvent)

			while (!aborted) {
				if (queue.length === 0) {
					await new Promise<void>(resolve => {
						resolver = resolve
					})
					continue
				}

				const next = queue.shift()
				if (!next) continue

				const mapped = mapEvent(next)
				yield sse({
					event: mapped.event,
					data: mapped.data
				})
				if (mapped.close) return
			}
		} finally {
			unsubscribe()
			request.signal.removeEventListener('abort', onAbort)
			sseState.activeClients = Math.max(
				0,
				sseState.activeClients - 1
			)
		}
	})()
}
