import type {
	ConnectionState,
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import { useLiveQuery } from '@tanstack/react-db'
import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import {
	destroyChatMessagesCollection,
	getChatMessagesCollection,
	getChatMessagesSyncHandle,
	type StoredChatMessage
} from '../collections/chat-messages'
import { type EventRow, StreamClient } from '../lib/stream'
import {
	type SessionStats,
	EMPTY_STATS,
	computeStatsFromEvents
} from '../lib/chat/session-stats'

/** Agent lifecycle event types */
const AGENT_START_TYPES = new Set(['agent_start'])
const AGENT_END_TYPES = new Set(['agent_end', 'run_closed'])

function isAgentRunOpen(rows: EventRow[]): boolean {
	let open = false
	for (const row of rows) {
		if (AGENT_START_TYPES.has(row.type)) open = true
		if (AGENT_END_TYPES.has(row.type)) open = false
	}
	return open
}

/** Convert an EventRow into a StoredChatMessage (no Date allocation). */
function eventToStored(row: EventRow): StoredChatMessage {
	const parsed =
		typeof row.payload === 'string'
			? (JSON.parse(row.payload) as Record<string, unknown>)
			: (row.payload as Record<string, unknown>)

	// The payload shape depends on event type
	let parts: ContentPart[] = []

	if (row.type === 'tool_call') {
		// tool_call payload: {id, name, arguments}
		parts = [
			{
				type: 'tool-call',
				name: parsed.name as string,
				args:
					(parsed.arguments as Record<string, unknown>) ??
					{},
				toolCallId: parsed.id as string
			}
		]
	} else if (row.type === 'tool_result') {
		// tool_result payload: {role, toolCallId, toolName, content, isError, ...}
		const resultContent = Array.isArray(parsed.content)
			? (
					parsed.content as Array<{
						type: string
						text?: string
					}>
				)
					.filter(c => c.type === 'text')
					.map(c => c.text ?? '')
					.join('')
			: ''
		parts = [
			{
				type: 'tool-result',
				toolName: parsed.toolName as string,
				toolCallId: parsed.toolCallId as string,
				result: resultContent
			}
		]
	} else if (
		row.type === 'memory_recall' ||
		row.type === 'memory_retain'
	) {
		// Memory events carry their parts directly in the payload
		parts = (parsed.parts as ContentPart[]) ?? []
	} else {
		// Standard message events: extract parts from content or parts array
		const content =
			typeof parsed.content === 'string'
				? parsed.content
				: ''
		if (Array.isArray(parsed.content)) {
			parts = parsed.content as ContentPart[]
		} else if (Array.isArray(parsed.parts)) {
			parts = parsed.parts as ContentPart[]
		} else if (content) {
			parts = [{ type: 'text', text: content }]
		}
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
	} else if (row.type.startsWith('memory_')) {
		sender = 'memory'
	}

	return {
		id: String(row.id),
		timestamp: new Date(row.createdAt).toISOString(),
		text,
		parts: filteredParts,
		seq: row.seq,
		sender,
		thinking
	}
}

export function useChatDB(sessionId: string) {
	const [connectionState, setConnectionState] =
		useState<ConnectionState>('disconnected')
	const [error, setError] = useState<string | null>(null)
	const [streamingMessage, setStreamingMessage] =
		useState<StoredChatMessage | null>(null)
	const [sessionVersion, setSessionVersion] = useState(0)
	const [sessionStats, setSessionStats] =
		useState<SessionStats>(EMPTY_STATS)
	const [isAgentRunning, setIsAgentRunning] =
		useState(false)

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

	const messages = (storedMessages ??
		[]) as StoredChatMessage[]

	// ── Helpers: push messages via the sync handle ─────────────────────
	const syncWrite = useCallback(
		(msgs: StoredChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			const collection =
				getChatMessagesCollection(sessionId)
			sync.begin()
			for (const msg of msgs) {
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
		(msgs: StoredChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			sync.begin()
			sync.truncate()
			for (const msg of msgs) {
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
		setIsAgentRunning(false)
		setError(null)
	}, [sessionId])

	// ── StreamClient setup ─────────────────────────────────────────────
	useEffect(() => {
		isInitialLoadRef.current = true
		// eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset state on sessionId change
		setSessionStats(EMPTY_STATS)
		setIsAgentRunning(false)

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
						e.type === 'tool_result' ||
						e.type === 'memory_recall' ||
						e.type === 'memory_retain'
				)
				const msgs = messageEvents.map(eventToStored)

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
				setIsAgentRunning(isAgentRunOpen(events))
			},

			onAppend(event) {
				// Track agent run lifecycle
				if (AGENT_START_TYPES.has(event.type)) {
					setIsAgentRunning(true)
				} else if (AGENT_END_TYPES.has(event.type)) {
					setIsAgentRunning(false)
				}

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
					let parsed: Record<string, unknown>
					try {
						parsed =
							typeof event.payload === 'string'
								? JSON.parse(event.payload)
								: event.payload
					} catch {
						return
					}
					const msg = parsed.message as Record<
						string,
						unknown
					>
					setStreamingMessage({
						id: `streaming-${event.id}`,
						timestamp: new Date(
							event.createdAt
						).toISOString(),
						text: '',
						parts: [],
						seq: event.seq,
						sender: msg?.role === 'user' ? 'user' : 'agent',
						isStreaming: true
					})
					return
				}

				if (event.type === 'message_update') {
					let parsed: Record<string, unknown>
					try {
						parsed =
							typeof event.payload === 'string'
								? JSON.parse(event.payload)
								: event.payload
					} catch {
						return
					}
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
					'tool_result',
					'memory_recall',
					'memory_retain'
				]
				if (!renderableTypes.includes(event.type)) return

				const msg = eventToStored(event)
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
		isAgentRunning,
		sendMessage,
		clearSession,
		retry
	}
}
