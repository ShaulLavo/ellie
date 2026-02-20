import { ChatPanel } from "./ChatPanel"

function App() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <h1>studio</h1>
      <div style={{ display: "flex", gap: 24 }}>
        <ChatPanel chatId="chat-1" />
        <ChatPanel chatId="chat-2" />
      </div>
    </div>
  )
}

export default App
