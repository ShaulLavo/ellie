import { useState } from "react"
import { useChat } from "./lib/chat/use-chat"

interface ChatPanelProps {
  chatId: string
}

export function ChatPanel({ chatId }: ChatPanelProps) {
  const { messages, isLoading, error, sendMessage, clearChat } = useChat(chatId)
  const [input, setInput] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    setInput("")
    sendMessage(text)
  }

  return (
    <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{chatId}</h2>
        <button
          onClick={clearChat}
          disabled={isLoading || messages.length === 0}
          style={{ padding: "4px 12px", cursor: "pointer" }}
        >
          Clear
        </button>
      </div>

      {error && <p style={{ color: "red" }}>{error.message}</p>}

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 8,
          padding: 16,
          minHeight: 200,
          marginBottom: 16,
          marginTop: 12,
        }}
      >
        {isLoading && <p style={{ opacity: 0.5 }}>connecting...</p>}

        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <strong>{m.role}:</strong> {m.content}
          </div>
        ))}

        {!isLoading && messages.length === 0 && (
          <p style={{ opacity: 0.5 }}>no messages yet</p>
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
