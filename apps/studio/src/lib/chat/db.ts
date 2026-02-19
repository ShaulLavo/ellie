import { createStreamDB, type StreamDB } from "@ellie/streams-state";
import { TreatyStreamTransport } from "@ellie/streams-client";
import { api } from "../api";
import { chatStateSchema } from "./schema";

export type ChatStreamDB = StreamDB<typeof chatStateSchema>;

/**
 * Create a StreamDB instance for a chat session.
 *
 * Uses Eden Treaty RPC through the named `/chat/:id` route for full
 * type-safe communication. The transport delegates to `api.chat({ id })`
 * which maps to the parameterized route on the backend.
 */
export function createChatStreamDB(chatId: string): ChatStreamDB {
  const transport = new TreatyStreamTransport({
    endpoint: () => api.chat({ id: chatId }),
    name: `chat/${chatId}`,
  });

  return createStreamDB({
    streamOptions: {
      // URL is required by DurableStream validation but not used for networking
      // when a transport is provided — it serves as a descriptive identifier.
      url: `${window.location.origin}/chat/${chatId}`,
      contentType: "application/json",
      transport,
    },
    state: chatStateSchema,
  });
}
