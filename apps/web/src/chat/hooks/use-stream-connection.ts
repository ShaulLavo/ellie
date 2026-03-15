import type { ConnectionState } from '@ellie/schemas/chat'
import {
	useEffect,
	useEffectEvent,
	useRef,
	useState
} from 'react'
import type { StoredChatMessage } from '@/chat/types'
import { StreamClient, type EventRow } from '@/lib/stream'
import type { BranchStats } from '@/lib/chat/branch-stats'
import {
	handleSnapshot,
	handleAppend,
	handleUpdate
} from '../utils/stream-callbacks'

interface StreamConnectionResult {
	connectionState: ConnectionState
	error: string | null
	streamingMessage: StoredChatMessage | null
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
	clearBranch: () => Promise<void>
	retry: () => void
}

export interface StreamConnectionDeps {
	branchId: string
	upsert: (msgs: StoredChatMessage[]) => void
	replaceAll: (msgs: StoredChatMessage[]) => void
	resetBranchState: () => void
	setBranchStats: (
		updater:
			| BranchStats
			| ((prev: BranchStats) => BranchStats)
	) => void
}

export function useStreamConnection(
	deps: StreamConnectionDeps
): StreamConnectionResult {
	const {
		branchId,
		upsert,
		replaceAll,
		resetBranchState,
		setBranchStats
	} = deps
	const [connectionState, setConnectionState] =
		useState<ConnectionState>('connecting')
	const [error, setError] = useState<string | null>(null)
	const [streamingMessage, setStreamingMessage] =
		useState<StoredChatMessage | null>(null)
	const [isAgentRunning, setIsAgentRunning] =
		useState(false)

	const streamRef = useRef<StreamClient | null>(null)

	const getDispatch = useEffectEvent(() => ({
		setStreamingMessage,
		setBranchStats,
		setIsAgentRunning,
		upsert,
		replaceAll,
		getStreamingMessage: () => streamingMessage
	}))

	const onStreamSnapshot = useEffectEvent(
		(
			events: EventRow[],
			branchChanged: boolean,
			_resolvedBranchId: string
		) => {
			handleSnapshot(events, branchChanged, getDispatch())
		}
	)

	const onStreamAppend = useEffectEvent((event: EventRow) =>
		handleAppend(event, getDispatch())
	)

	const onStreamUpdate = useEffectEvent((event: EventRow) =>
		handleUpdate(event, getDispatch())
	)

	useEffect(() => {
		const stream = new StreamClient(branchId, {
			onSnapshot: (
				events,
				branchChanged,
				resolvedBranchId
			) =>
				onStreamSnapshot(
					events,
					branchChanged,
					resolvedBranchId
				),
			onAppend: event => onStreamAppend(event),
			onUpdate: event => onStreamUpdate(event),
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
	}, [branchId])

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

	const clearBranch = async () => {
		const stream = streamRef.current
		if (!stream) return
		try {
			await stream.clearBranch()
			resetBranchState()
		} catch (err) {
			console.error('[chat-db] Clear failed:', err)
			setError('Failed to clear branch')
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
		isAgentRunning,
		sendMessage,
		clearBranch,
		retry
	}
}
