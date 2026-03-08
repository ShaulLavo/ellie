import type { ConnectionState } from '@ellie/schemas/chat'
import type { EventType } from '@ellie/schemas/events'
import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import type { StoredChatMessage } from '@/collections/chat-messages'
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

/** Event types that produce renderable chat messages. */
const RENDERABLE_TYPES: EventType[] = [
	'user_message',
	'assistant_message',
	'tool_execution',
	'memory_recall',
	'memory_retain',
	'session_rotated',
	'error'
]

interface StreamConnectionResult {
	connectionState: ConnectionState
	error: string | null
	streamingMessage: StoredChatMessage | null
	sessionStats: SessionStats
	isAgentRunning: boolean
	sendMessage: (
		text: string,
		attachments?: {
			uploadId: string
			mime: string
			size: number
			name: string
		}[],
		speechRef?: string
	) => Promise<void>
	clearSession: () => Promise<void>
	retry: () => void
}

export function useStreamConnection(
	sessionId: string,
	syncWrite: (msgs: StoredChatMessage[]) => void,
	syncReplaceAll: (msgs: StoredChatMessage[]) => void,
	resetSessionState: () => void
): StreamConnectionResult {
	const [connectionState, setConnectionState] =
		useState<ConnectionState>('disconnected')
	const [error, setError] = useState<string | null>(null)
	const [streamingMessage, setStreamingMessage] =
		useState<StoredChatMessage | null>(null)
	const [sessionStats, setSessionStats] =
		useState<SessionStats>(EMPTY_STATS)
	const [isAgentRunning, setIsAgentRunning] =
		useState(false)
	const [currentSessionId, setCurrentSessionId] =
		useState(sessionId)

	// Reset derived state during render when sessionId changes (avoids cascading renders from effect).
	if (currentSessionId !== sessionId) {
		setCurrentSessionId(sessionId)
		setSessionStats(EMPTY_STATS)
		setIsAgentRunning(false)
	}

	const streamRef = useRef<StreamClient | null>(null)

	useEffect(() => {
		const stream = new StreamClient(sessionId, {
			onSnapshot(events, sessionChanged) {
				const messageEvents = events.filter(e =>
					RENDERABLE_TYPES.includes(e.type as EventType)
				)
				const msgs = messageEvents
					.map(eventToStored)
					.filter(m => m.parts.length > 0 || m.text)

				if (sessionChanged) {
					// Session rotated — full replace and reset UI state
					setStreamingMessage(null)
					setSessionStats(EMPTY_STATS)
					setIsAgentRunning(false)
					syncReplaceAll(msgs)
				} else {
					if (msgs.length > 0) {
						syncWrite(msgs)
					}
				}

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
				} else if (!sessionChanged) {
					setStreamingMessage(null)
				}

				setSessionStats(computeStatsFromEvents(events))
				setIsAgentRunning(isAgentRunOpen(events))
			},

			onAppend(event) {
				if (AGENT_START_TYPES.has(event.type)) {
					setIsAgentRunning(true)
				} else if (AGENT_END_TYPES.has(event.type)) {
					setIsAgentRunning(false)
				}

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

				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0 && !msg.text) return
					syncWrite([msg])
					return
				}

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
						setStreamingMessage(null)
						if (stored.parts.length > 0 || stored.text) {
							syncWrite([stored])
						}

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

	const sendMessage = useCallback(
		async (
			text: string,
			attachments?: {
				uploadId: string
				mime: string
				size: number
				name: string
			}[],
			speechRef?: string
		) => {
			try {
				await streamRef.current?.sendMessage(
					text,
					undefined,
					attachments,
					speechRef
				)
			} catch (err) {
				console.error('[chat-db] Send failed:', err)
				setError('Failed to send message')
			}
		},
		[]
	)

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
		connectionState,
		error,
		streamingMessage,
		sessionStats,
		isAgentRunning,
		sendMessage,
		clearSession,
		retry
	}
}
