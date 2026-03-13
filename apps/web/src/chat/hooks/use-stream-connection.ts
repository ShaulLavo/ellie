import type { ConnectionState } from '@ellie/schemas/chat'
import type { EventType } from '@ellie/schemas/events'
import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import type { StoredChatMessage } from '@/collections/chat-messages'
import { StreamClient, type EventRow } from '@/lib/stream'
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

function isStreamingAssistantEvent(event: {
	type: string
	payload: unknown
}): boolean {
	if (event.type !== 'assistant_message') return false
	try {
		const parsed =
			typeof event.payload === 'string'
				? JSON.parse(event.payload)
				: event.payload
		return (
			(parsed as Record<string, unknown>).streaming === true
		)
	} catch {
		return false
	}
}

function isRenderableMessage(
	message: StoredChatMessage
): boolean {
	return (
		message.parts.length > 0 ||
		Boolean(message.text) ||
		Boolean(message.thinking)
	)
}

function toStreamingAssistantMessage(
	event: EventRow
): StoredChatMessage | null {
	const stored = eventToStored(event)
	if (!isRenderableMessage(stored)) return null
	return {
		...stored,
		isStreaming: true
	}
}

function getOpenStreamingAssistantEvent(
	events: EventRow[]
): EventRow | undefined {
	const closedRunIds = getClosedRunIds(events)

	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]
		if (!event || !isStreamingAssistantEvent(event))
			continue
		if (event.runId && closedRunIds.has(event.runId))
			continue
		return event
	}

	return undefined
}

function getClosedRunIds(events: EventRow[]): Set<string> {
	return new Set(
		events
			.filter(
				event =>
					event.type === 'run_closed' && event.runId != null
			)
			.map(event => event.runId as string)
	)
}

function isClosedRunEvent(
	event: EventRow,
	closedRunIds: Set<string>
): boolean {
	if (!event.runId) return false
	return closedRunIds.has(event.runId)
}

function shouldRenderInSnapshot(
	event: EventRow,
	lastRotatedIdx: number,
	closedRunIds: Set<string>
): boolean {
	if (!RENDERABLE_TYPES.includes(event.type as EventType)) {
		return false
	}
	if (
		event.type === 'session_rotated' &&
		event.seq !== lastRotatedIdx
	) {
		return false
	}
	if (!isStreamingAssistantEvent(event)) return true
	return isClosedRunEvent(event, closedRunIds)
}

function finalizeStreamingMessage(
	message: StoredChatMessage | null
): StoredChatMessage | null {
	if (!message) return null
	return {
		...message,
		isStreaming: false
	}
}

/** Event types that produce renderable chat messages. */
const RENDERABLE_TYPES: EventType[] = [
	'user_message',
	'assistant_message',
	'assistant_artifact',
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
	const streamingMessageRef =
		useRef<StoredChatMessage | null>(null)

	useEffect(() => {
		streamingMessageRef.current = streamingMessage
	}, [streamingMessage])

	useEffect(() => {
		const stream = new StreamClient(sessionId, {
			onSnapshot(events, sessionChanged) {
				// Keep only the last session_rotated event (duplicates may exist from hot-reload)
				let lastRotatedIdx = -1
				for (let i = events.length - 1; i >= 0; i--) {
					if (events[i].type === 'session_rotated') {
						lastRotatedIdx = events[i].seq
						break
					}
				}
				const closedRunIds = getClosedRunIds(events)

				const messageEvents = events.filter(event =>
					shouldRenderInSnapshot(
						event,
						lastRotatedIdx,
						closedRunIds
					)
				)
				const msgs = messageEvents
					.map(event => {
						const message = eventToStored(event)
						if (!isStreamingAssistantEvent(event)) {
							return message
						}
						return finalizeStreamingMessage(message)
					})
					.filter(
						(message): message is StoredChatMessage =>
							message != null &&
							isRenderableMessage(message)
					)

				// Snapshots are canonical full state. Always replace the local
				// collection so stale rows left over from disconnects/crashes
				// do not linger in the UI.
				if (sessionChanged) {
					// Session rotated — full replace and reset UI state
					setStreamingMessage(null)
					setSessionStats(EMPTY_STATS)
					setIsAgentRunning(false)
				}
				syncReplaceAll(msgs)

				const streamingEvent =
					getOpenStreamingAssistantEvent(events)
				if (streamingEvent) {
					setStreamingMessage(
						toStreamingAssistantMessage(streamingEvent)
					)
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
					const finalized = finalizeStreamingMessage(
						streamingMessageRef.current
					)
					if (finalized && isRenderableMessage(finalized)) {
						syncWrite([finalized])
					}
					setStreamingMessage(null)
				}

				if (event.type === 'assistant_message') {
					if (isStreamingAssistantEvent(event)) {
						setStreamingMessage(
							toStreamingAssistantMessage(event)
						)
						return
					}

					setStreamingMessage(null)
					const stored = eventToStored(event)
					if (!isRenderableMessage(stored)) return
					syncWrite([stored])

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
					return
				}

				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0 && !msg.text) return
					syncWrite([msg])
					return
				}

				if (event.type === 'assistant_artifact') {
					const msg = eventToStored(event)
					if (msg.parts.length === 0) return
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
					if (isStreamingAssistantEvent(event)) {
						setStreamingMessage(
							toStreamingAssistantMessage(event)
						)
						return
					}

					const stored = eventToStored(event)
					setStreamingMessage(null)
					if (isRenderableMessage(stored)) {
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
					return
				}

				if (event.type === 'tool_execution') {
					const msg = eventToStored(event)
					if (!isRenderableMessage(msg)) return
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
	}, [sessionId, syncReplaceAll, syncWrite])

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
