import { createStreamDB, type StreamDB } from "@ellie/streams-state";
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
      // Full stream path encoded into a single URL segment so it matches the
      // backend `:id` route (not the wildcard). Elysia auto-decodes path params,
      // so `chat%2Fdemo` → `chat/demo`. See: apps/app/src/routes/streams.ts
      url: `${window.location.origin}/streams/${encodeURIComponent(`chat/${chatId}`)}`,
      contentType: "application/json",
    },
    state: chatStateSchema,
  });
}
