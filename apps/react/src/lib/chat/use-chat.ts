import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'
import { env } from '@ellie/env/client'
import { eden } from '../eden'

// ============================================================================
// Types
// ============================================================================

export interface Message {
	role: string
	content: unknown[]
	timestamp: number
	[key: string]: unknown
}

/**
 * Mirrors packages/db/src/schema.ts → EventRow.
 * Intentionally duplicated: @ellie/db depends on bun:sqlite which cannot
 * be bundled into a browser build. Keep field names/types in sync manually.
 */
interface EventRow {
	id: number
	sessionId: string
	seq: number
	runId: string | null
	type: string
	payload: string
	dedupeKey: string | null
	createdAt: number
}

function parsePayload(
	row: EventRow
): Record<string, unknown> {
	try {
		return JSON.parse(row.payload) as Record<
			string,
			unknown
		>
	} catch {
		return {}
	}
}

export function isMessagePayload(
	payload: Record<string, unknown>
): payload is Message {
	return (
		typeof payload.role === 'string' &&
		Array.isArray(payload.content)
	)
}

function eventToMessage(row: EventRow): Message | null {
	const payload = parsePayload(row)
	if (
		row.type === 'user_message' ||
		row.type === 'assistant_final' ||
		row.type === 'tool_result'
	) {
		if (isMessagePayload(payload)) {
			console.log(
				`[useChat] eventToMessage id=${row.id} seq=${row.seq} type=${row.type} role=${payload.role} stopReason=${payload.stopReason ?? 'none'} errorMessage=${typeof payload.errorMessage === 'string' ? payload.errorMessage.slice(0, 100) : 'none'} contentLength=${Array.isArray(payload.content) ? payload.content.length : 0}`
			)
			return payload
		}
		console.warn(
			`[useChat] malformed payload for event id=${row.id} type=${row.type}:`,
			payload
		)
		return null
	}
	return null
}

function sortMessages(messages: Message[]): Message[] {
	return [...messages].sort(
		(a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
	)
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for a chat session backed by HTTP + SSE endpoints.
 * Uses the new event-store protocol with afterSeq cursoring.
 */
export function useChat(sessionId: string) {
	const [messages, setMessages] = useState<Message[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const [error, setError] = useState<Error | null>(null)
	const baseUrl = useMemo(
		() => env.API_BASE_URL.replace(/\/$/, ``),
		[]
	)
	const lastSeqRef = useRef(0)

	useEffect(() => {
		lastSeqRef.current = 0 // Reset cursor on session change
		let hasSnapshot = false
		const url = new URL(
			`${baseUrl}/chat/${encodeURIComponent(sessionId)}/events/sse`
		)
		if (lastSeqRef.current > 0) {
			url.searchParams.set(
				'afterSeq',
				String(lastSeqRef.current)
			)
		}

		const source = new EventSource(url.toString())

		setMessages([])
		setIsLoading(true)
		setError(null)

		const onSnapshot = (event: MessageEvent) => {
			try {
				const rows = JSON.parse(event.data) as EventRow[]
				hasSnapshot = true
				console.log(
					`[useChat] snapshot received rows=${rows.length} session=${sessionId}`
				)

				// Track highest seq
				for (const row of rows) {
					if (row.seq > lastSeqRef.current)
						lastSeqRef.current = row.seq
				}

				// Extract messages from events
				const msgs: Message[] = []
				for (const row of rows) {
					const msg = eventToMessage(row)
					if (msg) msgs.push(msg)
				}
				console.log(
					`[useChat] snapshot parsed messages=${msgs.length} (from ${rows.length} rows)`
				)
				setMessages(sortMessages(msgs))
				setIsLoading(false)
				setError(null)
			} catch (err) {
				console.error(
					'[useChat] failed to parse snapshot:',
					err
				)
			}
		}

		const onAppend = (event: MessageEvent) => {
			try {
				const row = JSON.parse(event.data) as EventRow
				console.log(
					`[useChat] append received id=${row.id} seq=${row.seq} type=${row.type} session=${sessionId}`
				)
				if (row.seq > lastSeqRef.current)
					lastSeqRef.current = row.seq

				const msg = eventToMessage(row)
				if (msg) {
					console.log(
						`[useChat] appending message role=${msg.role} stopReason=${msg.stopReason ?? 'none'}`
					)
					// Events arrive in monotonic seq order over SSE — just append
					setMessages(current => [...current, msg])
				} else {
					console.log(
						`[useChat] append skipped — eventToMessage returned null for type=${row.type}`
					)
				}
			} catch (err) {
				console.error(
					'[useChat] failed to parse append event:',
					err
				)
			}
		}

		const onError = (e: Event) => {
			console.error(
				`[useChat] SSE error session=${sessionId} hasSnapshot=${hasSnapshot}`,
				e
			)
			if (hasSnapshot) return
			setIsLoading(false)
			setError(
				new Error(`Failed to connect to chat stream`)
			)
		}

		source.addEventListener(`snapshot`, onSnapshot)
		source.addEventListener(`append`, onAppend)
		source.addEventListener(`error`, onError)

		return () => {
			source.removeEventListener(`snapshot`, onSnapshot)
			source.removeEventListener(`append`, onAppend)
			source.removeEventListener(`error`, onError)
			source.close()
		}
	}, [baseUrl, sessionId])

	const sendMessage = useCallback(
		async (
			content: string,
			role: 'user' | 'assistant' | 'system' = `user`
		) => {
			const trimmed = content.trim()
			if (!trimmed) return

			console.log(
				`[useChat] sendMessage role=${role} content=${trimmed.slice(0, 100)} session=${sessionId}`
			)

			try {
				const { error } = await eden
					.chat({ sessionId })
					.messages.post({
						role,
						content: trimmed
					})
				if (!error) {
					console.log(
						`[useChat] sendMessage success session=${sessionId}`
					)
					return
				}
				console.error(
					`[useChat] sendMessage got error response session=${sessionId}:`,
					error
				)
				throw new Error(
					`POST /chat/${sessionId}/messages failed`
				)
			} catch (err) {
				console.error(
					`[useChat] Failed to send message:`,
					err instanceof Error
						? err.message
						: JSON.stringify(err)
				)
				throw err
			}
		},
		[sessionId]
	)

	const clearChat = useCallback(async () => {
		try {
			const { error } = await eden
				.chat({ sessionId })
				.messages.delete()
			if (!error) return
			throw new Error(
				`DELETE /chat/${sessionId}/messages failed`
			)
		} catch (err) {
			console.error(
				`[useChat] Failed to clear chat:`,
				err instanceof Error
					? err.message
					: JSON.stringify(err)
			)
			throw err
		}
	}, [sessionId])

	return {
		messages,
		isLoading,
		error,
		sendMessage,
		clearChat
	}
}
