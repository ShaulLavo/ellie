import { ChatRoom } from './chat/chat-room'

function App() {
	return (
		<div className="h-screen flex overflow-hidden">
			<ChatRoom branchId="current" />
		</div>
	)
}

export default App
