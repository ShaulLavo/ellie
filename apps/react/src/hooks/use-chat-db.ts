import type {
	ChatMessage,
	ConnectionState,
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import { useLiveQuery } from '@tanstack/react-db'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'
import {
	destroyChatMessagesCollection,
	fromStored,
	getChatMessagesCollection,
	getChatMessagesSyncHandle,
	type StoredChatMessage,
	toStored
} from '../collections/chat-messages'
import { type EventRow, StreamClient } from '../lib/stream'
import type { SessionStats } from '../components/chat/session-status-bar'

/** Extract session stats (model, tokens, cost) from raw event rows. */
function computeStatsFromEvents(
	events: EventRow[]
): SessionStats {
	let model: string | null = null
	let provider: string | null = null
	let promptTokens = 0
	let completionTokens = 0
	let totalCost = 0
	let messageCount = 0

	for (const row of events) {
		if (
			row.type === 'user_message' ||
			row.type === 'assistant_final'
		) {
			messageCount++
		}

		if (row.type !== 'assistant_final') continue

		const parsed =
			typeof row.payload === 'string'
				? (JSON.parse(row.payload) as Record<
						string,
						unknown
					>)
				: (row.payload as Record<string, unknown>)

		if (typeof parsed.model === 'string')
			model = parsed.model
		if (typeof parsed.provider === 'string')
			provider = parsed.provider

		const usage = parsed.usage as
			| {
					input?: number
					output?: number
					cost?: { total?: number }
			  }
			| undefined
		if (usage) {
			promptTokens += usage.input ?? 0
			completionTokens += usage.output ?? 0
			totalCost += usage.cost?.total ?? 0
		}
	}

	return {
		model,
		provider,
		messageCount,
		promptTokens,
		completionTokens,
		totalCost
	}
}

const EMPTY_STATS: SessionStats = {
	model: null,
	provider: null,
	messageCount: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalCost: 0
}

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
		row.type === 'assistant_final' ||
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
	const [sessionStats, setSessionStats] =
		useState<SessionStats>(EMPTY_STATS)

	const streamRef = useRef<StreamClient | null>(null)
	const isInitialLoadRef = useRef(true)

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
		setSessionStats(EMPTY_STATS)
		setError(null)
	}, [sessionId])

	// ── StreamClient setup ─────────────────────────────────────────────
	useEffect(() => {
		isInitialLoadRef.current = true

		const stream = new StreamClient(sessionId, {
			onSnapshot(events) {
				// Filter to only renderable message events
				const messageEvents = events.filter(
					e =>
						e.type === 'user_message' ||
						e.type === 'assistant_message' ||
						e.type === 'assistant_final' ||
						e.type === 'system_message' ||
						e.type === 'tool_call' ||
						e.type === 'tool_result'
				)
				const msgs = messageEvents.map(eventToMessage)

				if (isInitialLoadRef.current) {
					// First connect: full replace
					syncReplaceAll(msgs)
					isInitialLoadRef.current = false
				} else {
					// Resync after visibility change: only add new events
					if (msgs.length > 0) {
						syncWrite(msgs)
					}
				}
				// Clear any stale streaming state on snapshot
				setStreamingMessage(null)

				// Compute session stats from all events
				setSessionStats(computeStatsFromEvents(events))
			},

			onAppend(event) {
				// Incrementally update session stats
				if (
					event.type === 'user_message' ||
					event.type === 'assistant_final'
				) {
					const delta = computeStatsFromEvents([event])
					setSessionStats(prev => ({
						model: delta.model ?? prev.model,
						provider: delta.provider ?? prev.provider,
						messageCount:
							prev.messageCount + delta.messageCount,
						promptTokens:
							prev.promptTokens + delta.promptTokens,
						completionTokens:
							prev.completionTokens +
							delta.completionTokens,
						totalCost: prev.totalCost + delta.totalCost
					}))
				}

				// Handle streaming events for live assistant responses
				if (event.type === 'message_start') {
					const parsed =
						typeof event.payload === 'string'
							? JSON.parse(event.payload)
							: event.payload
					const msg = parsed.message as Record<
						string,
						unknown
					>
					setStreamingMessage({
						id: `streaming-${event.id}`,
						timestamp: new Date(event.createdAt),
						text: '',
						parts: [],
						line: event.seq,
						sender: msg?.role === 'user' ? 'user' : 'agent',
						isStreaming: true
					})
					return
				}

				if (event.type === 'message_update') {
					const parsed =
						typeof event.payload === 'string'
							? JSON.parse(event.payload)
							: event.payload
					const streamEvent = parsed.streamEvent as
						| Record<string, unknown>
						| undefined
					if (!streamEvent) return

					setStreamingMessage(prev => {
						if (!prev) return prev
						const eventType = streamEvent.type as string

						if (
							eventType === 'text_delta' &&
							typeof streamEvent.delta === 'string'
						) {
							const newText =
								prev.text + (streamEvent.delta as string)
							return {
								...prev,
								text: newText,
								parts: [
									{
										type: 'text' as const,
										text: newText
									}
								]
							}
						}

						if (
							eventType === 'thinking_delta' &&
							typeof streamEvent.delta === 'string'
						) {
							return {
								...prev,
								thinking:
									(prev.thinking ?? '') +
									(streamEvent.delta as string)
							}
						}

						return prev
					})
					return
				}

				if (event.type === 'message_end') {
					// message_end carries the final message — let assistant_final handle persistence
					setStreamingMessage(null)
					return
				}

				const renderableTypes = [
					'user_message',
					'assistant_message',
					'assistant_final',
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
		sessionStats,
		sendMessage,
		clearSession,
		retry
	}
}
