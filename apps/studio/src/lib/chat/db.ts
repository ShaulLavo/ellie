import { createStreamDB, type StreamDB } from "@durable-streams/state";
import { chatStateSchema } from "./schema";

export type ChatStreamDB = StreamDB<typeof chatStateSchema>;

/**
 * Create a StreamDB instance for a chat session.
 *
 * Connects to the durable streams endpoint via the Vite dev proxy.
 * The stream path matches what the backend chat route creates: `/chat/{chatId}`
 */
export function createChatStreamDB(chatId: string): ChatStreamDB {
  return createStreamDB({
    streamOptions: {
      url: `${window.location.origin}/streams/chat/${chatId}`,
      contentType: "application/json",
    },
    state: chatStateSchema,
  });
}
