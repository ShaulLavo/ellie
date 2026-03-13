import type { ConnectionState } from '@ellie/schemas/chat'
import {
	useEffect,
	useEffectEvent,
	useRef,
	useState
} from 'react'
import type { StoredChatMessage } from '@/collections/chat-messages'
import { StreamClient } from '@/lib/stream'
import {
	type SessionStats,
	EMPTY_STATS
} from '@/lib/chat/session-stats'
import {
	handleSnapshot,
	handleAppend,
	handleUpdate,
	type StreamDispatch
} from '../utils/stream-callbacks'

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
		useState<ConnectionState>('connecting')
	const [error, setError] = useState<string | null>(null)
	const [streamingMessage, setStreamingMessage] =
		useState<StoredChatMessage | null>(null)
	const [sessionStats, setSessionStats] =
		useState<SessionStats>(EMPTY_STATS)
	const [isAgentRunning, setIsAgentRunning] =
		useState(false)
	const [currentSessionId, setCurrentSessionId] =
		useState(sessionId)

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

	const buildDispatch = useEffectEvent(
		(): StreamDispatch => ({
			setStreamingMessage,
			setSessionStats,
			setIsAgentRunning,
			syncWrite,
			syncReplaceAll,
			getStreamingMessage: () => streamingMessageRef.current
		})
	)

	useEffect(() => {
		const dispatch = buildDispatch()

		const stream = new StreamClient(sessionId, {
			onSnapshot: (events, sessionChanged) =>
				handleSnapshot(events, sessionChanged, dispatch),
			onAppend: event => handleAppend(event, dispatch),
			onUpdate: event => handleUpdate(event, dispatch),
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
	}, [sessionId])

	const sendMessage = async (
		text: string,
		attachments?: {
			uploadId: string
			mime: string
			size: number
			name: string
		}[],
		speechRef?: string
	) => {
		const stream = streamRef.current
		if (!stream) return
		try {
			await stream.sendMessage(
				text,
				undefined,
				attachments,
				speechRef
			)
		} catch (err) {
			console.error('[chat-db] Send failed:', err)
			setError('Failed to send message')
		}
	}

	const clearSession = async () => {
		const stream = streamRef.current
		if (!stream) return
		try {
			await stream.clearSession()
			resetSessionState()
		} catch (err) {
			console.error('[chat-db] Clear failed:', err)
			setError('Failed to clear session')
		}
	}

	const retry = () => {
		const stream = streamRef.current
		if (!stream) return
		stream.disconnect()
		stream.connect()
	}

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
