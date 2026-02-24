import type { AgentMessage } from "@ellie/agent";
import {
  agentAbortInputSchema,
  agentAbortOutputSchema,
  agentEventSchema,
  agentHistoryOutputSchema,
  agentMessageSchema,
  agentPromptInputSchema,
  agentPromptOutputSchema,
  agentSteerInputSchema,
  agentSteerOutputSchema,
} from "@ellie/schemas/agent";
import { Elysia, sse } from "elysia";
import * as v from "valibot";
import type { AgentManager } from "../agent/manager";
import type { AgentRunEvent, RealtimeStore, StreamMessageEvent } from "../lib/realtime-store";
import {
  chatParamsSchema,
  chatRunParamsSchema,
  errorSchema,
  parseAgentActionBody,
  toStreamGenerator,
  type SseState,
} from "./common";

export function createAgentRoutes(
  store: RealtimeStore,
  agentManager: AgentManager | null,
  sseState: SseState,
) {
  return new Elysia({ prefix: "/agent" })
    .get("/:chatId/messages", ({ params }) => {
      return store.listAgentMessages(params.chatId);
    }, {
      params: chatParamsSchema,
      response: v.array(agentMessageSchema),
    })
    .get("/:chatId/messages/sse", ({ params, request }) => {
      const stream = toStreamGenerator<StreamMessageEvent<AgentMessage>>(
        request,
        sseState,
        (listener) => store.subscribeToAgentMessages(params.chatId, listener),
        (event) => {
          if (event.type === `append`) {
            return { event: `append`, data: event.message };
          }
          return { event: `clear`, data: null };
        },
        { event: `snapshot`, data: store.listAgentMessages(params.chatId) },
      );

      return sse(stream);
    }, {
      params: chatParamsSchema,
    })
    .get("/:chatId/events/:runId", ({ params }) => {
      return store.listAgentRunEvents(params.chatId, params.runId);
    }, {
      params: chatRunParamsSchema,
      response: v.array(agentEventSchema),
    })
    .get("/:chatId/events/:runId/sse", ({ params, request }) => {
      const initialEvents: AgentRunEvent[] = store.isAgentRunClosed(params.chatId, params.runId)
        ? [{ type: `closed` }]
        : [];

      const stream = toStreamGenerator<AgentRunEvent>(
        request,
        sseState,
        (listener) => store.subscribeToAgentRun(params.chatId, params.runId, listener),
        (event) => {
          if (event.type === `event`) {
            return { event: `event`, data: event.event };
          }
          return { event: `closed`, data: null, close: true };
        },
        { event: `snapshot`, data: store.listAgentRunEvents(params.chatId, params.runId) },
        initialEvents,
      );

      return sse(stream);
    }, {
      params: chatRunParamsSchema,
    })
    .post("/:chatId/prompt", async ({ params, body, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      const message = parseAgentActionBody(body);
      const { runId } = await agentManager.prompt(params.chatId, message);
      return { runId, chatId: params.chatId, status: `started` as const };
    }, {
      params: chatParamsSchema,
      body: agentPromptInputSchema,
      response: {
        200: agentPromptOutputSchema,
        400: errorSchema,
        503: errorSchema,
      },
    })
    .post("/:chatId/steer", ({ params, body, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      const message = parseAgentActionBody(body);
      agentManager.steer(params.chatId, message);
      return { status: `queued` as const };
    }, {
      params: chatParamsSchema,
      body: agentSteerInputSchema,
      response: {
        200: agentSteerOutputSchema,
        400: errorSchema,
        503: errorSchema,
      },
    })
    .post("/:chatId/abort", ({ params, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      agentManager.abort(params.chatId);
      return { status: `aborted` as const };
    }, {
      params: chatParamsSchema,
      body: agentAbortInputSchema,
      response: {
        200: agentAbortOutputSchema,
        503: errorSchema,
      },
    })
    .get("/:chatId/history", ({ params, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      return { messages: agentManager.loadHistory(params.chatId) };
    }, {
      params: chatParamsSchema,
      response: {
        200: agentHistoryOutputSchema,
        503: errorSchema,
      },
    });
}
