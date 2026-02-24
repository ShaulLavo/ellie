import {
  agentAbortInputSchema,
  agentAbortOutputSchema,
  agentHistoryOutputSchema,
  agentPromptInputSchema,
  agentPromptOutputSchema,
  agentSteerInputSchema,
  agentSteerOutputSchema,
} from "@ellie/schemas/agent";
import { Elysia, sse } from "elysia";
import type { AgentManager } from "../agent/manager";
import type { AgentRunEvent, RealtimeStore, SessionEvent } from "../lib/realtime-store";
import {
  sessionParamsSchema,
  sessionRunParamsSchema,
  afterSeqQuerySchema,
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
    .get("/:sessionId/messages", ({ params }) => {
      return store.listAgentMessages(params.sessionId);
    }, {
      params: sessionParamsSchema,
    })
    .get("/:sessionId/events/sse", ({ params, query, request }) => {
      const afterSeq = query.afterSeq ? Number(query.afterSeq) : undefined;
      const existingEvents = store.queryEvents(params.sessionId, afterSeq);

      const stream = toStreamGenerator<SessionEvent>(
        request,
        sseState,
        (listener) => store.subscribeToSession(params.sessionId, listener),
        (event) => {
          if (event.type === "append") {
            return { event: `append`, data: event.event };
          }
          return { event: `run_closed`, data: event.runId };
        },
        { event: `snapshot`, data: existingEvents },
      );

      return sse(stream);
    }, {
      params: sessionParamsSchema,
      query: afterSeqQuerySchema,
    })
    .get("/:sessionId/events/:runId", ({ params }) => {
      return store.queryRunEvents(params.sessionId, params.runId);
    }, {
      params: sessionRunParamsSchema,
    })
    .get("/:sessionId/events/:runId/sse", ({ params, request }) => {
      const initialEvents: AgentRunEvent[] = store.isAgentRunClosed(params.sessionId, params.runId)
        ? [{ type: `closed` }]
        : [];

      const stream = toStreamGenerator<AgentRunEvent>(
        request,
        sseState,
        (listener) => store.subscribeToAgentRun(params.sessionId, params.runId, listener),
        (event) => {
          if (event.type === `event`) {
            return { event: `event`, data: event.event };
          }
          return { event: `closed`, data: null, close: true };
        },
        { event: `snapshot`, data: store.queryRunEvents(params.sessionId, params.runId) },
        initialEvents,
      );

      return sse(stream);
    }, {
      params: sessionRunParamsSchema,
    })
    .post("/:sessionId/prompt", async ({ params, body, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      const message = parseAgentActionBody(body);
      const { runId } = await agentManager.prompt(params.sessionId, message);
      return { runId, sessionId: params.sessionId, status: `started` as const };
    }, {
      params: sessionParamsSchema,
      body: agentPromptInputSchema,
      response: {
        200: agentPromptOutputSchema,
        400: errorSchema,
        503: errorSchema,
      },
    })
    .post("/:sessionId/steer", ({ params, body, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      const message = parseAgentActionBody(body);
      agentManager.steer(params.sessionId, message);
      return { status: `queued` as const };
    }, {
      params: sessionParamsSchema,
      body: agentSteerInputSchema,
      response: {
        200: agentSteerOutputSchema,
        400: errorSchema,
        503: errorSchema,
      },
    })
    .post("/:sessionId/abort", ({ params, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      agentManager.abort(params.sessionId);
      return { status: `aborted` as const };
    }, {
      params: sessionParamsSchema,
      body: agentAbortInputSchema,
      response: {
        200: agentAbortOutputSchema,
        503: errorSchema,
      },
    })
    .get("/:sessionId/history", ({ params, set }) => {
      if (!agentManager) {
        set.status = 503;
        return { error: `Agent routes unavailable: no ANTHROPIC_API_KEY configured` };
      }

      return { messages: agentManager.loadHistory(params.sessionId) };
    }, {
      params: sessionParamsSchema,
      response: {
        200: agentHistoryOutputSchema,
        503: errorSchema,
      },
    });
}
