import { sse } from 'elysia'
import * as v from 'valibot'

export const messageInputSchema = v.object({
	content: v.string(),
	role: v.optional(v.picklist([`user`, `assistant`, `system`]))
})

export type MessageInput = v.InferOutput<typeof messageInputSchema>

export const sessionParamsSchema = v.object({ sessionId: v.string() })
export const sessionRunParamsSchema = v.object({ sessionId: v.string(), runId: v.string() })
export const afterSeqQuerySchema = v.object({
	afterSeq: v.optional(
		v.pipe(v.string(), v.transform(Number), v.number(), v.finite(), v.integer(), v.minValue(0))
	)
})
export const statusSchema = v.object({ connectedClients: v.number() })
export const errorSchema = v.object({ error: v.string() })

export interface SseState {
	activeClients: number
}

export function normalizeMessageInput(body: MessageInput): MessageInput {
	const content = body.content.trim()
	if (content.length === 0) {
		throw new Error(`Missing 'content' field in request body`)
	}

	return {
		content,
		role: body.role
	}
}

export function parseAgentActionBody(body: { message: string }): string {
	const value = normalizeMessageInput({
		content: body.message,
		role: undefined
	})

	return value.content
}

export function toStreamGenerator<TEvent extends { type: string }>(
	request: Request,
	sseState: SseState,
	subscribe: (listener: (event: TEvent) => void) => () => void,
	mapEvent: (event: TEvent) => { event: string; data: unknown; close?: boolean },
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

		request.signal.addEventListener('abort', onAbort, { once: true })
		const unsubscribe = subscribe((event) => {
			queue.push(event)
			wake()
		})

		try {
			yield sse(snapshotEvent)

			while (!aborted) {
				if (queue.length === 0) {
					await new Promise<void>((resolve) => {
						resolver = resolve
					})
					continue
				}

				const next = queue.shift()
				if (!next) continue

				const mapped = mapEvent(next)
				yield sse({ event: mapped.event, data: mapped.data })
				if (mapped.close) return
			}
		} finally {
			unsubscribe()
			request.signal.removeEventListener('abort', onAbort)
			sseState.activeClients = Math.max(0, sseState.activeClients - 1)
		}
	})()
}
