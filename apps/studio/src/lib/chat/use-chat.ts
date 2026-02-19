import { useState, useEffect, useCallback, useRef } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { createChatStreamDB, type ChatStreamDB } from "./db";
import { chatStateSchema, type Message } from "./schema";

type StreamDbState =
  | { status: "loading" }
  | { status: "ready"; db: ChatStreamDB }
  | { status: "error"; error: Error };

/**
 * Hook for a chat session backed by Durable Streams + TanStack DB.
 *
 * Uses StreamDB to create TanStack DB collections from a durable stream,
 * then subscribes with useLiveQuery for reactive UI updates.
 *
 * Messages are written directly to the stream using the state protocol
 * (schema helpers create properly formatted change events).
 */
export function useChat(chatId: string) {
  const [state, setState] = useState<StreamDbState>({ status: "loading" });
  const streamDbRef = useRef<ChatStreamDB | null>(null);

  // Create and preload StreamDB when chatId changes
  useEffect(() => {
    let cancelled = false;
    const db = createChatStreamDB(chatId);
    streamDbRef.current = db;

    db.stream.create({ contentType: "application/json" })
      .then(() => db.preload())
      .then(() => {
        if (!cancelled) setState({ status: "ready", db });
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[useChat] Failed to preload StreamDB:", err instanceof Error ? err.message : JSON.stringify(err));
          setState({
            status: "error",
            error: err instanceof Error ? err : new Error("Failed to load chat"),
          });
        }
      });

    return () => {
      cancelled = true;
      db.close();
      streamDbRef.current = null;
    };
  }, [chatId]);

  const streamDb = state.status === "ready" ? state.db : null;

  // Live query: subscribe to messages collection
  const { data: rawMessages } = useLiveQuery(
    (q) =>
      streamDb
        ? q
            .from({ messages: streamDb.collections.messages })
            .orderBy(({ messages: m }) => m.createdAt, "asc")
        : null,
    [streamDb],
  );

  const messages: Message[] = rawMessages ?? [];

  // Send a message by appending a state-protocol event to the stream
  const sendMessage = useCallback(
    async (content: string, role: Message["role"] = "user") => {
      const db = streamDbRef.current;
      if (!db) return;

      const event = chatStateSchema.messages.insert({
        value: {
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        },
      });

      await db.stream.append(event);
    },
    [],
  );

  return {
    messages,
    isLoading: state.status === "loading",
    error: state.status === "error" ? state.error : null,
    sendMessage,
  };
}
