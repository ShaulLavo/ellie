import { useCallback, useEffect, useMemo, useState } from "react"
import { env } from "@ellie/env/client"
import { agentMessageSchema } from "@ellie/schemas/agent"
import type { InferOutput } from "valibot"
import { eden } from "../eden"

// ============================================================================
// Message type (derived from the router schema — stays in sync automatically)
// ============================================================================

export type AgentMessage = InferOutput<typeof agentMessageSchema>

type SseMessageEvent = AgentMessage[] | AgentMessage | null

function parseEventData(event: MessageEvent): SseMessageEvent {
  try {
    return JSON.parse(event.data) as SseMessageEvent
  } catch {
    return null
  }
}

function sortMessages(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort((a, b) => a.timestamp - b.timestamp)
}

function upsertMessage(messages: AgentMessage[], next: AgentMessage): AgentMessage[] {
  const match = messages.findIndex((item) => item.timestamp === next.timestamp && item.role === next.role)
  if (match === -1) {
    return sortMessages([...messages, next])
  }

  const copied = [...messages]
  copied[match] = next
  return sortMessages(copied)
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for an agent chat session backed by HTTP + SSE.
 *
 * Messages are persisted server-side in JSONL logs. The agent runs
 * server-side — this hook sends prompts via REST and subscribes to
 * live updates over SSE.
 */
export function useAgentChat(chatId: string) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const baseUrl = useMemo(() => env.API_BASE_URL.replace(/\/$/, ``), [])

  const [isSending, setIsSending] = useState(false)

  useEffect(() => {
    let hasSnapshot = false
    const source = new EventSource(
      `${baseUrl}/agent/${encodeURIComponent(chatId)}/messages/sse`
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
      setError(new Error(`Failed to connect to agent stream`))
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
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setIsSending(true)
      try {
        const { error } = await eden.agent({ chatId }).prompt.post({
          message: trimmed,
        })
        if (!error) return
        throw new Error(`POST /agent/${chatId}/prompt failed`)
      } catch (err) {
        console.error(
          `[useAgentChat] Failed to send message:`,
          err instanceof Error ? err.message : JSON.stringify(err),
        )
        throw err
      } finally {
        setIsSending(false)
      }
    },
    [chatId],
  )

  const steer = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      try {
        const { error } = await eden.agent({ chatId }).steer.post({
          message: trimmed,
        })
        if (!error) return
        throw new Error(`POST /agent/${chatId}/steer failed`)
      } catch (err) {
        console.error(
          `[useAgentChat] Failed to steer:`,
          err instanceof Error ? err.message : JSON.stringify(err),
        )
        throw err
      }
    },
    [chatId],
  )

  const abort = useCallback(
    async () => {
      try {
        const { error } = await eden.agent({ chatId }).abort.post()
        if (!error) return
        throw new Error(`POST /agent/${chatId}/abort failed`)
      } catch (err) {
        console.error(
          `[useAgentChat] Failed to abort:`,
          err instanceof Error ? err.message : JSON.stringify(err),
        )
        throw err
      }
    },
    [chatId],
  )

  return {
    messages,
    isLoading,
    isSending,
    error,
    sendMessage,
    steer,
    abort,
  }
}
