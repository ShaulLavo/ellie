import { useState } from "react"
import { cn } from "./lib/utils"
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
import { MessageResponse } from "./components/ai-elements/message"
import { Separator } from "./components/ui/separator"
import { Spinner } from "./components/ui/spinner"
import {
  ArrowUp,
  Moon,
  Paperclip,
  Sun,
  Trash,
  Robot,
  User,
  Monitor,
} from "@phosphor-icons/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { useTheme } from "./hooks/use-theme"

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

function ModeToggle() {
  const { setPreference } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <ChatHeaderButton title="Toggle theme">
          <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </ChatHeaderButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setPreference("light")}>
          <Sun className="size-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPreference("dark")}>
          <Moon className="size-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPreference("system")}>
          <Monitor className="size-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
          <ModeToggle />
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

        <div className="flex flex-col py-2">
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
                  <ChatEvent className="items-center gap-1 my-4">
                    <Separator className="flex-1" />
                    <ChatEventTime
                      timestamp={msg.createdAt}
                      format="longDate"
                      className="text-xs text-muted-foreground font-semibold min-w-max"
                    />
                    <Separator className="flex-1" />
                  </ChatEvent>
                )}

                <ChatEvent className={cn(
                  "group hover:bg-accent transition-colors py-0.5",
                  isFirst && idx > 0 && !showDateSep && "mt-3"
                )}>
                  <ChatEventAddon className={isFirst ? "" : "pt-0 items-center"}>
                    {isFirst ? (
                      <ChatEventAvatar
                        fallback={
                          isUser ? (
                            <User weight="fill" className="size-3.5" />
                          ) : (
                            <Robot weight="fill" className="size-3.5" />
                          )
                        }
                        className={cn(
                          "size-7 @md/chat:size-8",
                          isAssistant
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground"
                        )}
                      />
                    ) : (
                      <ChatEventTime
                        timestamp={msg.createdAt}
                        format="time"
                        className="text-right text-[10px] leading-tight opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-full text-muted-foreground/50"
                      />
                    )}
                  </ChatEventAddon>

                  <ChatEventBody>
                    {isFirst && (
                      <ChatEventTitle>
                        <span className="font-medium capitalize">
                          {msg.role}
                        </span>
                        <ChatEventTime
                          timestamp={msg.createdAt}
                          className="text-[10px] text-muted-foreground/50"
                        />
                      </ChatEventTitle>
                    )}
                    <ChatEventContent className="text-sm">
                      <MessageResponse>{msg.content}</MessageResponse>
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
        <ChatToolbarAddon align="inline-start">
          <ChatToolbarButton title="Attach" className="rounded-full size-7">
            <Paperclip className="size-4" />
          </ChatToolbarButton>
        </ChatToolbarAddon>
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
            className="bg-primary text-primary-foreground hover:bg-primary/90 size-7 rounded-full"
            title="Send"
          >
            <ArrowUp weight="bold" className="size-3.5" />
          </ChatToolbarButton>
        </ChatToolbarAddon>
      </ChatToolbar>
    </Chat>
  )
}
