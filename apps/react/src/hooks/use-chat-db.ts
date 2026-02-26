import {
	useState,
	useEffect,
	useRef,
	useCallback,
	useMemo
} from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type {
	ChatMessage,
	ConnectionState,
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import {
	getChatMessagesCollection,
	getChatMessagesSyncHandle,
	destroyChatMessagesCollection,
	toStored,
	fromStored,
	type StoredChatMessage
} from '../collections/chat-messages'
import { StreamClient, type EventRow } from '../lib/stream'

/** Convert an EventRow from the event store into a ChatMessage. */
function eventToMessage(row: EventRow): ChatMessage {
	const parsed =
		typeof row.payload === 'string'
			? (JSON.parse(row.payload) as Record<string, unknown>)
			: (row.payload as Record<string, unknown>)

	// The payload shape depends on event type
	const content =
		typeof parsed.content === 'string' ? parsed.content : ''

	// Extract parts — could be in payload.content as anthropic content blocks
	// or directly in payload.parts
	let parts: ContentPart[] = []
	if (Array.isArray(parsed.content)) {
		parts = parsed.content as ContentPart[]
	} else if (Array.isArray(parsed.parts)) {
		parts = parsed.parts as ContentPart[]
	} else if (content) {
		parts = [{ type: 'text', text: content }]
	}

	const text = parts
		.filter(
			(p): p is Extract<ContentPart, { type: 'text' }> =>
				p.type === 'text'
		)
		.map(p => p.text)
		.join('\n')

	const thinking =
		parts
			.filter(
				(
					p
				): p is Extract<
					ContentPart,
					{ type: 'thinking' }
				> => p.type === 'thinking'
			)
			.map(p => p.text)
			.join('\n') || undefined

	const filteredParts = thinking
		? parts.filter(p => p.type !== 'thinking')
		: parts

	// Determine sender from event type or payload
	let sender: MessageSender | undefined
	if (
		row.type === 'user_message' ||
		parsed.role === 'user'
	) {
		sender = 'user'
	} else if (
		row.type === 'assistant_message' ||
		parsed.role === 'assistant'
	) {
		sender = 'agent'
	} else if (
		row.type === 'system_message' ||
		parsed.role === 'system'
	) {
		sender = 'system'
	} else if (row.type.startsWith('tool_')) {
		sender = 'agent'
	}

	return {
		id: String(row.id),
		timestamp: new Date(row.createdAt),
		text,
		parts: filteredParts,
		line: row.seq,
		sender,
		thinking
	}
}

export function useChatDB(sessionId: string) {
	const [connectionState, setConnectionState] =
		useState<ConnectionState>('disconnected')
	const [error, setError] = useState<string | null>(null)
	const [streamingMessage, setStreamingMessage] =
		useState<ChatMessage | null>(null)
	const [sessionVersion, setSessionVersion] = useState(0)

	const streamRef = useRef<StreamClient | null>(null)

	// ── Live query: reactive sorted messages ───────────────────────────
	const { data: storedMessages } = useLiveQuery(
		q =>
			q
				.from({
					msg: getChatMessagesCollection(sessionId)
				})
				.orderBy(
					({ msg }) =>
						(msg as unknown as StoredChatMessage).seq,
					'asc'
				),
		[sessionId, sessionVersion]
	)

	const messages = useMemo(() => {
		if (!storedMessages) return []
		return (storedMessages as StoredChatMessage[]).map(
			fromStored
		)
	}, [storedMessages])

	// ── Helpers: push messages via the sync handle ─────────────────────
	const syncWrite = useCallback(
		(msgs: ChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			const collection =
				getChatMessagesCollection(sessionId)
			const stored = msgs.map(toStored)
			sync.begin()
			for (const msg of stored) {
				sync.write(
					msg,
					collection.has(msg.id) ? 'update' : 'insert'
				)
			}
			sync.commit()
		},
		[sessionId]
	)

	const syncReplaceAll = useCallback(
		(msgs: ChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			const stored = msgs.map(toStored)
			sync.begin()
			sync.truncate()
			for (const msg of stored) {
				sync.write(msg, 'insert')
			}
			sync.commit()
		},
		[sessionId]
	)

	const resetSessionState = useCallback(() => {
		destroyChatMessagesCollection(sessionId)
		setSessionVersion(v => v + 1)
		setStreamingMessage(null)
		setError(null)
	}, [sessionId])

	// ── StreamClient setup ─────────────────────────────────────────────
	useEffect(() => {
		const stream = new StreamClient(sessionId, {
			onSnapshot(events) {
				// Filter to only renderable message events
				const messageEvents = events.filter(
					e =>
						e.type === 'user_message' ||
						e.type === 'assistant_message' ||
						e.type === 'system_message' ||
						e.type === 'tool_call' ||
						e.type === 'tool_result'
				)
				const msgs = messageEvents.map(eventToMessage)
				syncReplaceAll(msgs)
			},

			onAppend(event) {
				const renderableTypes = [
					'user_message',
					'assistant_message',
					'system_message',
					'tool_call',
					'tool_result'
				]
				if (!renderableTypes.includes(event.type)) return

				const msg = eventToMessage(event)
				syncWrite([msg])
			},

			onStateChange(state) {
				setConnectionState(state)
				if (state === 'connected') setError(null)
			},

			onError(message) {
				setError(message)
			}
		})

		streamRef.current = stream
		stream.connect()

		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				streamRef.current?.resync()
			}
		}
		document.addEventListener(
			'visibilitychange',
			onVisibilityChange
		)

		return () => {
			document.removeEventListener(
				'visibilitychange',
				onVisibilityChange
			)
			stream.disconnect()
			streamRef.current = null
		}
	}, [sessionId, syncWrite, syncReplaceAll])

	// ── Actions ───────────────────────────────────────────────────────

	const sendMessage = useCallback(async (text: string) => {
		try {
			await streamRef.current?.sendMessage(text)
		} catch (err) {
			console.error('[chat-db] Send failed:', err)
			setError('Failed to send message')
		}
	}, [])

	const clearSession = useCallback(async () => {
		try {
			await streamRef.current?.clearSession()
			resetSessionState()
		} catch (err) {
			console.error('[chat-db] Clear failed:', err)
			setError('Failed to clear session')
		}
	}, [resetSessionState])

	const retry = useCallback(() => {
		streamRef.current?.disconnect()
		streamRef.current?.connect()
	}, [])

	return {
		messages,
		streamingMessage,
		connectionState,
		error,
		sendMessage,
		clearSession,
		retry
	}
}
