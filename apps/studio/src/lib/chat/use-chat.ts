import { useCallback } from "react"
import { createRpcClient } from "@ellie/streams-rpc/client"
import { useStream } from "@ellie/streams-rpc/react"
import { appRouter, type AppRouter } from "../../../../app/src/rpc/router"

// ============================================================================
// RPC Client (singleton)
// ============================================================================

const rpc = createRpcClient<AppRouter>(appRouter, {
  baseUrl: window.location.origin,
})

// ============================================================================
// Message type (inferred from the router schema)
// ============================================================================

export type Message = {
  id: string
  role: `user` | `assistant` | `system`
  content: string
  createdAt: string
}

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

  // TODO: clearChat requires stream-level delete + re-subscribe.
  // For now, this is a no-op placeholder. Stream deletion needs
  // to be exposed via the RPC layer or handled separately.
  const clearChat = useCallback(async () => {
    console.warn(`[useChat] clearChat not yet implemented via RPC layer`)
  }, [])

  return {
    messages: messages as Message[],
    isLoading,
    error,
    sendMessage,
    clearChat,
  }
}
