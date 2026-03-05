import type { ConnectionState } from '@ellie/schemas/chat'
import type { EventType } from '@ellie/schemas/events'
import { useLiveQuery } from '@tanstack/react-db'
import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import {
	getChatMessagesCollection,
	type StoredChatMessage
} from '@/collections/chat-messages'
import { StreamClient } from '@/lib/stream'
import {
	type SessionStats,
	EMPTY_STATS,
	computeStatsFromEvents
} from '@/lib/chat/session-stats'
import {
	AGENT_START_TYPES,
	AGENT_END_TYPES,
	isAgentRunOpen,
	eventToStored
} from '../event-transforms'
import { useChatSync } from './use-chat-sync'

/** Event types that produce renderable chat messages. */
const RENDERABLE_TYPES: EventType[] = [
	'user_message',
	'assistant_message',
	'tool_execution',
	'memory_recall',
	'memory_retain',
	'error'
]

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

	const { syncWrite, syncReplaceAll, destroyCollection } =
		useChatSync(sessionId)

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

	const resetSessionState = useCallback(() => {
		destroyCollection()
		setSessionVersion(v => v + 1)
		setStreamingMessage(null)
		setSessionStats(EMPTY_STATS)
		setIsAgentRunning(false)
		setError(null)
	}, [destroyCollection])

	// ── StreamClient setup ─────────────────────────────────────────────
	useEffect(() => {
		isInitialLoadRef.current = true
		// eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset state on sessionId change
		setSessionStats(EMPTY_STATS)
		setIsAgentRunning(false)

		const stream = new StreamClient(sessionId, {
			onSnapshot(events) {
				// Filter to only renderable message events
				const messageEvents = events.filter(e =>
					RENDERABLE_TYPES.includes(e.type as EventType)
				)
				const msgs = messageEvents
					.map(eventToStored)
					.filter(m => m.parts.length > 0 || m.text)

				if (isInitialLoadRef.current) {
					syncReplaceAll(msgs)
					isInitialLoadRef.current = false
				} else {
					if (msgs.length > 0) {
						syncWrite(msgs)
					}
				}

				// Check for in-flight assistant_message (reconnect during streaming)
				const streamingEvent = events.find(e => {
					if (e.type !== 'assistant_message') return false
					try {
						const p =
							typeof e.payload === 'string'
								? JSON.parse(e.payload)
								: e.payload
						return (
							(p as Record<string, unknown>).streaming ===
							true
						)
					} catch {
						return false
					}
				})
				if (streamingEvent) {
					const stored = eventToStored(streamingEvent)
					setStreamingMessage({
						...stored,
						isStreaming: true
					})
				} else {
					setStreamingMessage(null)
				}

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

				// assistant_message append = start streaming
				if (event.type === 'assistant_message') {
					setStreamingMessage({
						id: String(event.id),
						timestamp: new Date(
							event.createdAt
						).toISOString(),
						text: '',
						parts: [],
						seq: event.seq,
						sender: 'agent',
						isStreaming: true
					})
					return
				}

				// tool_execution append = tool started
				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0 && !msg.text) return
					syncWrite([msg])
					return
				}

				// Incrementally update session stats for user messages
				if (event.type === 'user_message') {
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

				if (
					!RENDERABLE_TYPES.includes(
						event.type as EventType
					)
				)
					return

				const msg = eventToStored(event)
				if (msg.parts.length === 0 && !msg.text) return
				syncWrite([msg])
			},

			onUpdate(event) {
				if (event.type === 'assistant_message') {
					let parsed: Record<string, unknown>
					try {
						parsed =
							typeof event.payload === 'string'
								? JSON.parse(event.payload)
								: (event.payload as Record<string, unknown>)
					} catch {
						return
					}

					const streaming = parsed.streaming as boolean
					const stored = eventToStored(event)

					if (streaming) {
						setStreamingMessage({
							...stored,
							isStreaming: true
						})
					} else {
						// Streaming done — finalize
						setStreamingMessage(null)
						syncWrite([stored])

						// Update session stats with the completed message
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
					return
				}

				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0 && !msg.text) return
					syncWrite([msg])
					return
				}
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
