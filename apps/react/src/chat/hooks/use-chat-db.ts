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
				const messageEvents = events.filter(
					e =>
						e.type === 'user_message' ||
						e.type === 'assistant_message' ||
						e.type === 'tool_execution' ||
						e.type === 'assistant_final' ||
						e.type === 'tool_call' ||
						e.type === 'tool_result' ||
						e.type === 'memory_recall' ||
						e.type === 'memory_retain'
				)
				const msgs = messageEvents
					.map(eventToStored)
					.filter(m => m.parts.length > 0 || m.text)

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

				// New unified type: assistant_message append = start streaming
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

				// New unified type: tool_execution append = tool started
				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0 && !msg.text) return
					syncWrite([msg])
					return
				}

				// Incrementally update session stats (legacy path)
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

				const renderableTypes: EventType[] = [
					'user_message',
					'assistant_final',
					'tool_call',
					'tool_result',
					'memory_recall',
					'memory_retain',
					'error'
				]
				if (!renderableTypes.includes(event.type)) return

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
						// Still streaming — update the overlay message
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
