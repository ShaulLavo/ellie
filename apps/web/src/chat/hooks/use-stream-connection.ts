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

function getOpenStreamingAssistantEvent(
	events: EventRow[]
): EventRow | undefined {
	const closedRunIds = new Set(
		events
			.filter(
				event =>
					event.type === 'run_closed' && event.runId != null
			)
			.map(event => event.runId as string)
	)

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

/** Event types that produce renderable chat messages. */
const RENDERABLE_TYPES: EventType[] = [
	'user_message',
	'assistant_message',
	'assistant_audio',
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
				// Keep only the last session_rotated event (duplicates may exist from hot-reload)
				let lastRotatedIdx = -1
				for (let i = events.length - 1; i >= 0; i--) {
					if (events[i].type === 'session_rotated') {
						lastRotatedIdx = i
						break
					}
				}

				const messageEvents = events.filter(
					(e, i) =>
						RENDERABLE_TYPES.includes(
							e.type as EventType
						) &&
						!isStreamingAssistantEvent(e) &&
						(e.type !== 'session_rotated' ||
							i === lastRotatedIdx)
				)
				const msgs = messageEvents
					.map(eventToStored)
					.filter(m => m.parts.length > 0 || m.text)

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
					setStreamingMessage(null)
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

					// Check raw text for [[tts]] — voice-only messages
					// should never show text, even while streaming.
					const rawParts = (parsed.content ??
						parsed.parts) as
						| { type: string; text?: string }[]
						| undefined
					const rawText =
						rawParts
							?.filter(p => p.type === 'text')
							.map(p => p.text ?? '')
							.join('') ?? ''
					const isTts = /\[\[tts(?::[^\]]*?)?\]\]/i.test(
						rawText
					)

					const stored = eventToStored(event)

					if (streaming) {
						if (isTts) {
							// [[tts]] detected — hide streaming text entirely.
							// Audio will arrive via a separate assistant_audio event.
							setStreamingMessage(null)
						} else {
							setStreamingMessage({
								...stored,
								isStreaming: true
							})
						}
					} else {
						setStreamingMessage(null)
						// Skip empty messages — [[tts]] suppresses text in display,
						// and the audio player arrives via a separate assistant_audio event.
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
