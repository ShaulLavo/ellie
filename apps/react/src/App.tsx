import { ChatPanel } from "./ChatPanel"

function App() {
  return (
    <div className="h-screen flex overflow-hidden">
      <ChatPanel chatId="chat-1" />
      <ChatPanel chatId="chat-2" />
    </div>
  )
}

export default App
