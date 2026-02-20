import { useCallback } from "react"
import { useStream } from "@ellie/streams-rpc/react"
import type { InferSchema } from "@ellie/streams-rpc"
import { rpc, type AppRouter } from "../rpc"

// ============================================================================
// Message type (derived from the router schema — stays in sync automatically)
// ============================================================================

export type Message = InferSchema<AppRouter[`chat`][`collections`][`messages`][`schema`]>

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for a chat session backed by Durable Streams via the RPC layer.
 *
 * Uses useStream() for reactive subscription + typed mutations.
 */
export function useChat(chatId: string) {
  const {
    data: messages,
    isLoading,
    error,
    insert,
    clear,
  } = useStream(rpc.chat.messages, { chatId })

  const sendMessage = useCallback(
    async (content: string, role: Message[`role`] = `user`) => {
      try {
        await insert({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        } as Message)
      } catch (err) {
        console.error(
          `[useChat] Failed to send message:`,
          err instanceof Error ? err.message : JSON.stringify(err)
        )
        throw err
      }
    },
    [insert]
  )

  const clearChat = useCallback(async () => {
    try {
      await clear()
    } catch (err) {
      console.error(
        `[useChat] Failed to clear chat:`,
        err instanceof Error ? err.message : JSON.stringify(err)
      )
      throw err
    }
  }, [clear])

  return {
    messages: messages as Message[],
    isLoading,
    error,
    sendMessage,
    clearChat,
  }
}
