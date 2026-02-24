import { useCallback, useEffect, useMemo, useState } from "react"
import { env } from "@ellie/env/client"
import { messageSchema } from "@ellie/schemas/router"
import type { InferOutput } from "valibot"
import { eden } from "../eden"

// ============================================================================
// Message type (derived from the router schema — stays in sync automatically)
// ============================================================================

export type Message = InferOutput<typeof messageSchema>

type SseMessageEvent = Message[] | Message | null

function parseEventData(event: MessageEvent): SseMessageEvent {
  try {
    return JSON.parse(event.data) as SseMessageEvent
  } catch {
    return null
  }
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
}

function upsertMessage(messages: Message[], next: Message): Message[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) {
    return sortMessages([...messages, next])
  }

  const copied = [...messages]
  copied[index] = next
  return sortMessages(copied)
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for a chat session backed by HTTP + SSE endpoints.
 */
export function useChat(chatId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const baseUrl = useMemo(() => env.API_BASE_URL.replace(/\/$/, ``), [])

  useEffect(() => {
    let hasSnapshot = false
    const source = new EventSource(
      `${baseUrl}/chat/${encodeURIComponent(chatId)}/messages/sse`
    )

    setMessages([])
    setIsLoading(true)
    setError(null)

    const onSnapshot = (event: MessageEvent) => {
      const payload = parseEventData(event)
      if (!Array.isArray(payload)) return
      hasSnapshot = true
      setMessages(sortMessages(payload))
      setIsLoading(false)
      setError(null)
    }

    const onAppend = (event: MessageEvent) => {
      const payload = parseEventData(event)
      if (!payload || Array.isArray(payload)) return
      setMessages((current) => upsertMessage(current, payload))
    }

    const onClear = () => {
      setMessages([])
    }

    const onError = () => {
      if (hasSnapshot) return
      setIsLoading(false)
      setError(new Error(`Failed to connect to chat stream`))
    }

    source.addEventListener(`snapshot`, onSnapshot)
    source.addEventListener(`append`, onAppend)
    source.addEventListener(`clear`, onClear)
    source.addEventListener(`error`, onError)

    return () => {
      source.removeEventListener(`snapshot`, onSnapshot)
      source.removeEventListener(`append`, onAppend)
      source.removeEventListener(`clear`, onClear)
      source.removeEventListener(`error`, onError)
      source.close()
    }
  }, [baseUrl, chatId])

  const sendMessage = useCallback(
    async (content: string, role: Message[`role`] = `user`) => {
      const trimmed = content.trim()
      if (!trimmed) return

      try {
        const { error } = await eden.chat({ chatId }).messages.post({
          role,
          content: trimmed,
        })
        if (!error) return
        throw new Error(`POST /chat/${chatId}/messages failed`)
      } catch (err) {
        console.error(
          `[useChat] Failed to send message:`,
          err instanceof Error ? err.message : JSON.stringify(err)
        )
        throw err
      }
    },
    [chatId]
  )

  const clearChat = useCallback(async () => {
    try {
      const { error } = await eden.chat({ chatId }).messages.delete()
      if (!error) return
      throw new Error(`DELETE /chat/${chatId}/messages failed`)
    } catch (err) {
      console.error(
        `[useChat] Failed to clear chat:`,
        err instanceof Error ? err.message : JSON.stringify(err)
      )
      throw err
    }
  }, [chatId])

  return {
    messages,
    isLoading,
    error,
    sendMessage,
    clearChat,
  }
}
