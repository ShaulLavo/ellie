import { createStreamDB, type StreamDB } from "@ellie/streams-state";
import { FetchStreamTransport } from "@ellie/streams-client";
import { chatStateSchema } from "./schema";

export type ChatStreamDB = StreamDB<typeof chatStateSchema>;

/**
 * Create a StreamDB instance for a chat session.
 *
 * Uses FetchStreamTransport to communicate with the /chat/:id route.
 */
export function createChatStreamDB(chatId: string): ChatStreamDB {
  const transport = new FetchStreamTransport({
    baseUrl: window.location.origin,
    streamId: `chat/${chatId}`,
  });

  return createStreamDB({
    streamOptions: {
      url: `${window.location.origin}/chat/${chatId}`,
      contentType: "application/json",
      transport,
    },
    state: chatStateSchema,
  });
}
