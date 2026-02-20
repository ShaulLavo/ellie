import { useCallback, useState } from "react"
import { useStream } from "@ellie/rpc/react"
import type { InferSchema } from "@ellie/rpc"
import { rpc, type AppRouter } from "../rpc"
import { env } from "@ellie/env/client"

// ============================================================================
// Message type (derived from the router schema — stays in sync automatically)
// ============================================================================

export type AgentMessage = InferSchema<AppRouter[`agent`][`collections`][`messages`][`schema`]>

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for an agent chat session backed by Durable Streams.
 *
 * Messages are persisted server-side in JSONL logs. The agent runs
 * server-side — this hook sends prompts via REST and subscribes to
 * the messages stream for real-time updates.
 */
export function useAgentChat(chatId: string) {
  const {
    data: messages,
    isLoading,
    error,
  } = useStream(rpc.agent.messages, { chatId }, {
    orderBy: { field: `timestamp`, direction: `asc` },
  })

  const [currentRunId, setCurrentRunId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  const sendMessage = useCallback(
    async (text: string) => {
      setIsSending(true)
      try {
        const res = await fetch(`${env.API_BASE_URL}/agent/${chatId}/prompt`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ message: text }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as any).error || `Failed to send message`)
        }

        const { runId } = await res.json() as { runId: string }
        setCurrentRunId(runId)
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
      try {
        const res = await fetch(`${env.API_BASE_URL}/agent/${chatId}/steer`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ message: text }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as any).error || `Failed to steer`)
        }
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
        const res = await fetch(`${env.API_BASE_URL}/agent/${chatId}/abort`, {
          method: `POST`,
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as any).error || `Failed to abort`)
        }
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
    currentRunId,
  }
}
