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
			console.log(
				`[useAgentChat] eventToMessage id=${row.id} seq=${row.seq} type=${row.type} role=${payload.role} stopReason=${payload.stopReason ?? 'none'} errorMessage=${typeof payload.errorMessage === 'string' ? payload.errorMessage.slice(0, 100) : 'none'} contentLength=${Array.isArray(payload.content) ? payload.content.length : 0}`
			)
			return payload
		}
		console.warn(
			`[useAgentChat] malformed payload for event ${row.id}:`,
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

/** Agent lifecycle event types */
const AGENT_START_TYPES = new Set(['agent_start'])
const AGENT_END_TYPES = new Set(['agent_end', 'run_closed'])

/**
 * Scan a snapshot of event rows to determine if an agent
 * run is currently active (has agent_start without a
 * subsequent agent_end / run_closed).
 */
function isAgentRunOpen(rows: EventRow[]): boolean {
	let open = false
	for (const row of rows) {
		if (AGENT_START_TYPES.has(row.type)) open = true
		if (AGENT_END_TYPES.has(row.type)) open = false
	}
	return open
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for an agent chat session backed by HTTP + SSE.
 *
 * Messages are persisted via the chat route. The server-side
 * AgentWatcher auto-routes new user messages to the agent
 * when one is available.
 */
export function useAgentChat(sessionId: string) {
	const [messages, setMessages] = useState<AgentMessage[]>(
		[]
	)
	const [isLoading, setIsLoading] = useState(true)
	const [isAgentRunning, setIsAgentRunning] =
		useState(false)
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
		setIsAgentRunning(false)
		setError(null)

		const onSnapshot = (event: MessageEvent) => {
			try {
				const rows = JSON.parse(event.data) as EventRow[]
				hasSnapshot = true
				console.log(
					`[useAgentChat] snapshot received rows=${rows.length} session=${sessionId}`
				)

				for (const row of rows) {
					if (row.seq > lastSeqRef.current)
						lastSeqRef.current = row.seq
				}

				const msgs: AgentMessage[] = []
				for (const row of rows) {
					const msg = eventToMessage(row)
					if (msg) msgs.push(msg)
				}
				console.log(
					`[useAgentChat] snapshot parsed messages=${msgs.length} (from ${rows.length} rows)`
				)
				setMessages(sortMessages(msgs))
				setIsAgentRunning(isAgentRunOpen(rows))
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
				console.log(
					`[useAgentChat] append received id=${row.id} seq=${row.seq} type=${row.type} session=${sessionId}`
				)
				if (row.seq > lastSeqRef.current)
					lastSeqRef.current = row.seq

				// Track agent run lifecycle
				if (AGENT_START_TYPES.has(row.type)) {
					setIsAgentRunning(true)
				} else if (AGENT_END_TYPES.has(row.type)) {
					setIsAgentRunning(false)
				}

				const msg = eventToMessage(row)
				if (msg) {
					console.log(
						`[useAgentChat] appending message role=${msg.role} stopReason=${msg.stopReason ?? 'none'}`
					)
					// Events arrive in monotonic seq order over SSE — just append
					setMessages(current => [...current, msg])
				} else {
					console.log(
						`[useAgentChat] append skipped — eventToMessage returned null for type=${row.type}`
					)
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
		async (text: string) => {
			const trimmed = text.trim()
			if (!trimmed) return
			console.log(
				`[useAgentChat] sendMessage content=${trimmed.slice(0, 100)} session=${sessionId}`
			)
			setIsSending(true)
			try {
				const { error: chatError } = await eden
					.chat({ sessionId })
					.messages.post({
						role: 'user',
						content: trimmed
					})
				if (chatError) {
					throw new Error(
						`POST /chat/${sessionId}/messages failed`
					)
				}
				console.log(
					`[useAgentChat] sendMessage success session=${sessionId}`
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
		isAgentRunning,
		error,
		sendMessage,
		steer,
		abort
	}
}
