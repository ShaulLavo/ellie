import { useEffect, useState } from 'react'
import { ChatRoom } from './components/chat-room'
import { eden } from './lib/eden'

function App() {
	const [sessionId, setSessionId] = useState<string | null>(
		null
	)

	useEffect(() => {
		eden.api.session.today.get().then(({ data }) => {
			if (data?.sessionId) setSessionId(data.sessionId)
		})
	}, [])

	// Re-check every 60s for midnight rollover
	useEffect(() => {
		if (!sessionId) return
		const interval = setInterval(async () => {
			const { data } = await eden.api.session.today.get()
			if (data?.sessionId && data.sessionId !== sessionId) {
				setSessionId(data.sessionId)
			}
		}, 60_000)
		return () => clearInterval(interval)
	}, [sessionId])

	if (!sessionId) return null

	return (
		<div className="h-screen flex overflow-hidden">
			<ChatRoom sessionId={sessionId} />
		</div>
	)
}

export default App
