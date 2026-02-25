import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'
import { env } from '@ellie/env/client'
import { eden } from '../eden'
import { isMessagePayload, type Message } from './use-chat'

// ============================================================================
// Types
// ============================================================================

type AgentMessage = Message

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

function eventToMessage(
	row: EventRow
): AgentMessage | null {
	const payload = parsePayload(row)
	if (
		row.type === 'user_message' ||
		row.type === 'assistant_final' ||
		row.type === 'tool_result'
	) {
		if (isMessagePayload(payload)) {
			return payload
		}
		console.warn(
			`[eventToMessage] malformed payload for event ${row.id}:`,
			payload
		)
		return null
	}
	return null
}

function sortMessages(
	messages: AgentMessage[]
): AgentMessage[] {
	return [...messages].sort(
		(a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
	)
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for an agent chat session backed by HTTP + SSE.
 *
 * Events are persisted server-side in SQLite. The agent runs
 * server-side — this hook sends prompts via REST and subscribes to
 * live updates over SSE.
 */
export function useAgentChat(sessionId: string) {
	const [messages, setMessages] = useState<AgentMessage[]>(
		[]
	)
	const [isLoading, setIsLoading] = useState(true)
	const [error, setError] = useState<Error | null>(null)
	const baseUrl = useMemo(
		() => env.API_BASE_URL.replace(/\/$/, ``),
		[]
	)
	const lastSeqRef = useRef(0)

	const [isSending, setIsSending] = useState(false)

	useEffect(() => {
		lastSeqRef.current = 0 // Reset cursor on session change
		let hasSnapshot = false
		const url = new URL(
			`${baseUrl}/agent/${encodeURIComponent(sessionId)}/events/sse`
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

				for (const row of rows) {
					if (row.seq > lastSeqRef.current)
						lastSeqRef.current = row.seq
				}

				const msgs: AgentMessage[] = []
				for (const row of rows) {
					const msg = eventToMessage(row)
					if (msg) msgs.push(msg)
				}
				setMessages(sortMessages(msgs))
				setIsLoading(false)
				setError(null)
			} catch (err) {
				console.warn(
					'[useAgentChat] failed to parse snapshot:',
					err
				)
			}
		}

		const onAppend = (event: MessageEvent) => {
			try {
				const row = JSON.parse(event.data) as EventRow
				if (row.seq > lastSeqRef.current)
					lastSeqRef.current = row.seq

				const msg = eventToMessage(row)
				if (msg) {
					// Events arrive in monotonic seq order over SSE — just append
					setMessages(current => [...current, msg])
				}
			} catch (err) {
				console.warn(
					'[useAgentChat] failed to parse event:',
					err
				)
			}
		}

		const onError = () => {
			if (hasSnapshot) return
			setIsLoading(false)
			setError(
				new Error(`Failed to connect to agent stream`)
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
		async (text: string) => {
			const trimmed = text.trim()
			if (!trimmed) return
			setIsSending(true)
			try {
				const { error } = await eden
					.agent({ sessionId })
					.prompt.post({
						message: trimmed
					})
				if (!error) return
				throw new Error(
					`POST /agent/${sessionId}/prompt failed`
				)
			} catch (err) {
				console.error(
					`[useAgentChat] Failed to send message:`,
					err instanceof Error
						? err.message
						: JSON.stringify(err)
				)
				throw err
			} finally {
				setIsSending(false)
			}
		},
		[sessionId]
	)

	const steer = useCallback(
		async (text: string) => {
			const trimmed = text.trim()
			if (!trimmed) return
			try {
				const { error } = await eden
					.agent({ sessionId })
					.steer.post({
						message: trimmed
					})
				if (!error) return
				throw new Error(
					`POST /agent/${sessionId}/steer failed`
				)
			} catch (err) {
				console.error(
					`[useAgentChat] Failed to steer:`,
					err instanceof Error
						? err.message
						: JSON.stringify(err)
				)
				throw err
			}
		},
		[sessionId]
	)

	const abort = useCallback(async () => {
		try {
			const { error } = await eden
				.agent({ sessionId })
				.abort.post()
			if (!error) return
			throw new Error(
				`POST /agent/${sessionId}/abort failed`
			)
		} catch (err) {
			console.error(
				`[useAgentChat] Failed to abort:`,
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
		isSending,
		error,
		sendMessage,
		steer,
		abort
	}
}
