import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { env } from "@ellie/env/client"
import { eden } from "../eden"

// ============================================================================
// Types
// ============================================================================

export interface Message {
  role: string
  content: unknown[]
  timestamp: number
  [key: string]: unknown
}

/** Mirrors packages/db/src/schema.ts → EventRow (keep in sync) */
interface EventRow {
  id: number
  sessionId: string
  seq: number
  runId: string | null
  type: string
  payload: string
  dedupeKey: string | null
  createdAt: number
}

function parsePayload(row: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    return {}
  }
}

function eventToMessage(row: EventRow): Message | null {
  const payload = parsePayload(row)
  if (
    row.type === "user_message" ||
    row.type === "assistant_final" ||
    row.type === "tool_result"
  ) {
    return payload as unknown as Message
  }
  return null
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for a chat session backed by HTTP + SSE endpoints.
 * Uses the new event-store protocol with afterSeq cursoring.
 */
export function useChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const baseUrl = useMemo(() => env.API_BASE_URL.replace(/\/$/, ``), [])
  const lastSeqRef = useRef(0)

  useEffect(() => {
    let hasSnapshot = false
    const url = new URL(
      `${baseUrl}/chat/${encodeURIComponent(sessionId)}/events/sse`
    )
    if (lastSeqRef.current > 0) {
      url.searchParams.set("afterSeq", String(lastSeqRef.current))
    }

    const source = new EventSource(url.toString())

    setMessages([])
    setIsLoading(true)
    setError(null)

    const onSnapshot = (event: MessageEvent) => {
      try {
        const rows = JSON.parse(event.data) as EventRow[]
        hasSnapshot = true

        // Track highest seq
        for (const row of rows) {
          if (row.seq > lastSeqRef.current) lastSeqRef.current = row.seq
        }

        // Extract messages from events
        const msgs: Message[] = []
        for (const row of rows) {
          const msg = eventToMessage(row)
          if (msg) msgs.push(msg)
        }
        setMessages(sortMessages(msgs))
        setIsLoading(false)
        setError(null)
      } catch {
        // Parse error
      }
    }

    const onAppend = (event: MessageEvent) => {
      try {
        const row = JSON.parse(event.data) as EventRow
        if (row.seq > lastSeqRef.current) lastSeqRef.current = row.seq

        const msg = eventToMessage(row)
        if (msg) {
          setMessages((current) => sortMessages([...current, msg]))
        }
      } catch {
        // Parse error
      }
    }

    const onError = () => {
      if (hasSnapshot) return
      setIsLoading(false)
      setError(new Error(`Failed to connect to chat stream`))
    }

    source.addEventListener(`snapshot`, onSnapshot)
    source.addEventListener(`append`, onAppend)
    source.addEventListener(`error`, onError)

    return () => {
      source.removeEventListener(`snapshot`, onSnapshot)
      source.removeEventListener(`append`, onAppend)
      source.removeEventListener(`error`, onError)
      source.close()
    }
  }, [baseUrl, sessionId])

  const sendMessage = useCallback(
    async (content: string, role: "user" | "assistant" | "system" = `user`) => {
      const trimmed = content.trim()
      if (!trimmed) return

      try {
        const { error } = await eden.chat({ sessionId }).messages.post({
          role,
          content: trimmed,
        })
        if (!error) return
        throw new Error(`POST /chat/${sessionId}/messages failed`)
      } catch (err) {
        console.error(
          `[useChat] Failed to send message:`,
          err instanceof Error ? err.message : JSON.stringify(err)
        )
        throw err
      }
    },
    [sessionId]
  )

  const clearChat = useCallback(async () => {
    try {
      const { error } = await eden.chat({ sessionId }).messages.delete()
      if (!error) return
      throw new Error(`DELETE /chat/${sessionId}/messages failed`)
    } catch (err) {
      console.error(
        `[useChat] Failed to clear chat:`,
        err instanceof Error ? err.message : JSON.stringify(err)
      )
      throw err
    }
  }, [sessionId])

  return {
    messages,
    isLoading,
    error,
    sendMessage,
    clearChat,
  }
}
