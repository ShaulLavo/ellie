import {
	useQuery,
	useQueryClient
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { StoredChatMessage } from '@/chat/types'
import { eden } from '@/lib/eden'
import type { EventRow } from '@/lib/stream'
import {
	replaceMessages,
	upsertMessages
} from '../utils/message-cache'
import { snapshotToMessages } from '../utils/snapshot-transform'

function chatMessagesKey(sessionId: string) {
	return ['chat-messages', sessionId] as const
}

export function useChatMessages(sessionId: string) {
	const queryClient = useQueryClient()
	// Monotonic epoch: bumped by clear() and replaceAll() so
	// late-arriving bootstrap fetches from a stale epoch are discarded.
	const epochRef = useRef(0)
	// Track which sessionId the epoch belongs to so we reset on switch.
	const sessionRef = useRef(sessionId)
	useEffect(() => {
		if (sessionRef.current !== sessionId) {
			sessionRef.current = sessionId
			epochRef.current = 0
		}
	}, [sessionId])

	const { data: messages = [] } = useQuery({
		queryKey: chatMessagesKey(sessionId),
		queryFn: async () => {
			const fetchEpoch = epochRef.current
			const { data, error } = await eden
				.chat({ sessionId })
				.events.get()
			if (error) throw error
			// If SSE snapshot or clear() bumped the epoch while
			// we were fetching, discard this stale result.
			if (epochRef.current !== fetchEpoch) {
				return (
					queryClient.getQueryData<StoredChatMessage[]>(
						chatMessagesKey(sessionId)
					) ?? []
				)
			}
			return snapshotToMessages(data as EventRow[])
		},
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY
	})

	/** Merge messages by id, latest write wins, sorted by seq. */
	const upsert = (msgs: StoredChatMessage[]) => {
		queryClient.setQueryData<StoredChatMessage[]>(
			chatMessagesKey(sessionId),
			prev => upsertMessages(prev, msgs)
		)
	}

	/** Replace entire cache contents. SSE snapshot is authoritative. */
	const replaceAll = (msgs: StoredChatMessage[]) => {
		epochRef.current++
		queryClient.cancelQueries({
			queryKey: chatMessagesKey(sessionId)
		})
		queryClient.setQueryData<StoredChatMessage[]>(
			chatMessagesKey(sessionId),
			prev => replaceMessages(prev, msgs)
		)
	}

	/** Clear cache to empty. */
	const clear = () => {
		epochRef.current++
		queryClient.cancelQueries({
			queryKey: chatMessagesKey(sessionId)
		})
		queryClient.setQueryData<StoredChatMessage[]>(
			chatMessagesKey(sessionId),
			[]
		)
	}

	return { messages, upsert, replaceAll, clear }
}
