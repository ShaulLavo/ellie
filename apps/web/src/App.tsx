import { ChatRoom } from './chat'

function App() {
	return (
		<div className="h-screen flex overflow-hidden">
			<ChatRoom sessionId="current" />
		</div>
	)
}

export default App
