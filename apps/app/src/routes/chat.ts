import { Elysia, sse } from "elysia";
import * as v from "valibot";
import { messageSchema } from "@ellie/schemas/router";
import type { ChatMessage, RealtimeStore, StreamMessageEvent } from "../lib/realtime-store";
import {
  chatParamsSchema,
  errorSchema,
  messageInputSchema,
  normalizeMessageInput,
  toStreamGenerator,
  type SseState,
} from "./common";

export function createChatRoutes(store: RealtimeStore, sseState: SseState) {
  return new Elysia({ prefix: "/chat" })
    .get("/:chatId/messages", ({ params }) => {
      return store.listChatMessages(params.chatId);
    }, {
      params: chatParamsSchema,
      response: v.array(messageSchema),
    })
    .post("/:chatId/messages", ({ params, body }) => {
      const input = normalizeMessageInput(body);
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        role: input.role ?? `user`,
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      store.appendChatMessage(params.chatId, message);
      return message;
    }, {
      params: chatParamsSchema,
      body: messageInputSchema,
      response: {
        200: messageSchema,
        400: errorSchema,
      },
    })
    .delete("/:chatId/messages", ({ params }) => {
      store.clearChatMessages(params.chatId);
      return new Response(null, { status: 204 });
    }, {
      params: chatParamsSchema,
    })
    .get("/:chatId/messages/sse", ({ params, request }) => {
      const stream = toStreamGenerator<StreamMessageEvent<ChatMessage>>(
        request,
        sseState,
        (listener) => store.subscribeToChatMessages(params.chatId, listener),
        (event) => {
          if (event.type === `append`) {
            return { event: `append`, data: event.message };
          }
          return { event: `clear`, data: null };
        },
        { event: `snapshot`, data: store.listChatMessages(params.chatId) },
      );

      return sse(stream);
    }, {
      params: chatParamsSchema,
    });
}
