import { useState } from "react";
import { useChat } from "./lib/chat/use-chat";

function App() {
  const [chatId] = useState("demo");
  const { messages, isLoading, error, sendMessage } = useChat(chatId);
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 24 }}>
      <h1>studio</h1>

      {error && <p style={{ color: "red" }}>{error.message}</p>}

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 8,
          padding: 16,
          minHeight: 200,
          marginBottom: 16,
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
  );
}

export default App;
