import {
	messagesToTranscript,
	renderTranscript
} from '@ellie/schemas/chat'
import type { StoredChatMessage } from '@/chat/types'

export function downloadTranscript(
	allMessages: StoredChatMessage[],
	sessionId: string
) {
	if (allMessages.length === 0) return

	const chatMessages = allMessages.map(m => ({
		...m,
		timestamp: new Date(m.timestamp),
		line: m.seq
	}))
	const transcript = messagesToTranscript(chatMessages)
	const text = renderTranscript(transcript)
	const blob = new Blob([text], { type: 'text/plain' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = `transcript-${sessionId}-${new Date().toISOString().slice(0, 10)}.txt`
	document.body.append(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}
