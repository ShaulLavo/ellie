import { useCallback, useState } from "react"
import { useStream } from "@ellie/rpc/react"
import type { InferSchema } from "@ellie/rpc"
import { rpc, type AppRouter } from "../rpc"

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

  const [isSending, setIsSending] = useState(false)

  const sendMessage = useCallback(
    async (text: string) => {
      setIsSending(true)
      try {
        await rpc.agentPrompt({ chatId, input: { message: text } })
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
        await rpc.agentSteer({ chatId, input: { message: text } })
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
        await rpc.agentAbort({ chatId, input: undefined })
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
