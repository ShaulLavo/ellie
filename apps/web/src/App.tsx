import { ChatRoom } from './chat/chat-room'
import { useAssistantCurrent } from './chat/hooks/use-assistant-current'

function App() {
	const { branchId, threadId, isLoading } =
		useAssistantCurrent()

	if (isLoading || !branchId || !threadId) {
		return (
			<div className="h-screen flex items-center justify-center text-muted-foreground text-sm">
				Connecting...
			</div>
		)
	}

	return (
		<div className="h-screen flex overflow-hidden">
			<ChatRoom branchId={branchId} threadId={threadId} />
		</div>
	)
}

export default App
