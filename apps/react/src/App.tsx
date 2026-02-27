import { ChatRoom } from './components/chat-room'

function App() {
	return (
		<div className="h-screen flex overflow-hidden">
			<ChatRoom sessionId="current" />
		</div>
	)
}

export default App
