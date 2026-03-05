import { ChatRoom } from './chat'
import { ThemeProvider } from '@/components/theme-provider'

function App() {
	return (
		<ThemeProvider defaultTheme="dark" storageKey="ellie-theme">
			<div className="h-screen flex overflow-hidden">
				<ChatRoom sessionId="current" />
			</div>
		</ThemeProvider>
	)
}

export default App
