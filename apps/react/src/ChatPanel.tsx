import { useState } from "react"
import { useChat } from "./lib/chat/use-chat"
import type { Message } from "./lib/chat/use-chat"
import { Chat } from "./components/chat/chat"
import {
  ChatHeader,
  ChatHeaderAddon,
  ChatHeaderAvatar,
  ChatHeaderButton,
  ChatHeaderMain,
} from "./components/chat/chat-header"
import { ChatMessages } from "./components/chat/chat-messages"
import {
  ChatToolbar,
  ChatToolbarAddon,
  ChatToolbarButton,
  ChatToolbarTextarea,
} from "./components/chat/chat-toolbar"
import {
  ChatEvent,
  ChatEventAddon,
  ChatEventAvatar,
  ChatEventBody,
  ChatEventContent,
  ChatEventTime,
  ChatEventTitle,
} from "./components/chat/chat-event"
import { Separator } from "./components/ui/separator"
import { Spinner } from "./components/ui/spinner"
import {
  ArrowUp,
  Trash,
  Robot,
  User,
} from "@phosphor-icons/react"

interface ChatPanelProps {
  chatId: string
}

const CHAT_LABEL: Record<string, string> = {
  "chat-1": "General",
  "chat-2": "Research",
}

function groupMessages(messages: Message[]) {
  const groups: Array<{ msg: Message; isFirst: boolean }> = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const prev = messages[i - 1]
    const isFirst =
      !prev ||
      prev.role !== msg.role ||
      new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000
    groups.push({ msg, isFirst })
  }
  return groups
}

export function ChatPanel({ chatId }: ChatPanelProps) {
  const { messages, isLoading, error, sendMessage, clearChat } = useChat(chatId)
  const [input, setInput] = useState("")

  const handleSubmit = () => {
    const text = input.trim()
    if (!text) return
    setInput("")
    sendMessage(text)
  }

  const label = CHAT_LABEL[chatId] ?? chatId
  const grouped = groupMessages(messages)

  return (
    <Chat className="flex-1 min-w-0 border-r last:border-r-0">
      {/* ── Header ─────────────────────────────────────── */}
      <ChatHeader className="border-b">
        <ChatHeaderAddon>
          <ChatHeaderAvatar fallback={label[0]} />
        </ChatHeaderAddon>
        <ChatHeaderMain>
          <div className="grid">
            <span className="text-sm font-semibold leading-tight truncate">
              {label}
            </span>
            <span className="text-xs text-muted-foreground leading-tight">
              {isLoading
                ? "connecting…"
                : `${messages.length} message${messages.length !== 1 ? "s" : ""}`}
            </span>
          </div>
        </ChatHeaderMain>
        <ChatHeaderAddon>
          {isLoading && <Spinner className="size-4 text-muted-foreground" />}
          <ChatHeaderButton
            onClick={clearChat}
            disabled={isLoading || messages.length === 0}
            title="Clear chat"
          >
            <Trash />
          </ChatHeaderButton>
        </ChatHeaderAddon>
      </ChatHeader>

      {/* ── Messages ───────────────────────────────────── */}
      <ChatMessages>
        {/* rendered bottom-to-top because of flex-col-reverse */}
        {error && (
          <p className="mx-4 my-2 text-xs text-destructive">
            {error.message}
          </p>
        )}

        {!isLoading && messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">No messages yet</p>
          </div>
        )}

        <div className="flex flex-col gap-0.5 py-2">
          {grouped.map(({ msg, isFirst }, idx) => {
            const isUser = msg.role === "user"
            const isAssistant = msg.role === "assistant"

            /* date separator between different calendar days */
            const prev = grouped[idx - 1]?.msg
            const showDateSep =
              prev &&
              new Date(msg.createdAt).toDateString() !==
                new Date(prev.createdAt).toDateString()

            return (
              <div key={msg.id}>
                {showDateSep && (
                  <ChatEvent className="items-center gap-2 my-3 px-4">
                    <Separator className="flex-1" />
                    <ChatEventTime
                      timestamp={msg.createdAt}
                      format="longDate"
                      className="text-xs text-muted-foreground font-medium min-w-max"
                    />
                    <Separator className="flex-1" />
                  </ChatEvent>
                )}

                <ChatEvent className="group hover:bg-accent/40 transition-colors rounded-sm py-0.5">
                  <ChatEventAddon>
                    {isFirst ? (
                      <ChatEventAvatar
                        fallback={
                          isUser ? (
                            <User weight="fill" className="size-4" />
                          ) : (
                            <Robot weight="fill" className="size-4" />
                          )
                        }
                        className={
                          isAssistant
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground"
                        }
                      />
                    ) : (
                      <ChatEventTime
                        timestamp={msg.createdAt}
                        format="time"
                        className="text-right text-[9px] leading-none group-hover:visible invisible w-full"
                      />
                    )}
                  </ChatEventAddon>

                  <ChatEventBody className="pb-0.5">
                    {isFirst && (
                      <ChatEventTitle>
                        <span className="font-semibold text-sm capitalize">
                          {msg.role}
                        </span>
                        <ChatEventTime
                          timestamp={msg.createdAt}
                          format="time"
                          className="text-xs text-muted-foreground"
                        />
                      </ChatEventTitle>
                    )}
                    <ChatEventContent className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {msg.content}
                    </ChatEventContent>
                  </ChatEventBody>
                </ChatEvent>
              </div>
            )
          })}
        </div>
      </ChatMessages>

      {/* ── Toolbar ────────────────────────────────────── */}
      <ChatToolbar>
        <ChatToolbarTextarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSubmit={handleSubmit}
          placeholder="Message…"
          disabled={isLoading}
        />
        <ChatToolbarAddon align="inline-end">
          <ChatToolbarButton
            onClick={handleSubmit}
            disabled={isLoading || !input.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 size-8"
            title="Send"
          >
            <ArrowUp />
          </ChatToolbarButton>
        </ChatToolbarAddon>
      </ChatToolbar>
    </Chat>
  )
}
