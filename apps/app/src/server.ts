import { resolve } from "node:path";
import { JsonlEngine } from "@ellie/db";
import { env } from "@ellie/env/server";
import { AgentManager } from "./agent/manager";
import { anthropicText, type AnthropicChatModel } from "@tanstack/ai-anthropic";
import { Elysia, sse } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { RealtimeStore, type AgentRunEvent, type ChatMessage, type StreamMessageEvent } from "./lib/realtime-store";
import * as v from "valibot";
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
import { messageSchema } from "@ellie/schemas/router";

const parsedUrl = new URL(env.API_BASE_URL);
const port = parsedUrl.port !== "" ? Number(parsedUrl.port) : parsedUrl.protocol === "https:" ? 443 : 80;
const { DATA_DIR } = env;

console.log(`[server] DATA_DIR=${DATA_DIR}`);

const engine = new JsonlEngine(`${DATA_DIR}/streams.db`, `${DATA_DIR}/logs`);
const store = new RealtimeStore(engine);

// ── Agent manager ────────────────────────────────────────────────
// Initialized eagerly at startup. Requires ANTHROPIC_API_KEY in env.
const agentManager: AgentManager | null = env.ANTHROPIC_API_KEY
  ? new AgentManager(store, {
      adapter: anthropicText(env.ANTHROPIC_MODEL as AnthropicChatModel),
      systemPrompt: "You are a helpful assistant.",
    })
  : null;

// ── Studio frontend ───────────────────────────────────────────────
// import.meta.dir = .../apps/app/src/
const STUDIO_PUBLIC = resolve(import.meta.dir, "../../react/public");

// ── Request handler ───────────────────────────────────────────────
const messageInputSchema = v.object({
  content: v.string(),
  role: v.optional(v.picklist([`user`, `assistant`, `system`])),
});

type MessageInput = v.InferOutput<typeof messageInputSchema>;
const chatParamsSchema = v.object({ chatId: v.string() });
const chatRunParamsSchema = v.object({ chatId: v.string(), runId: v.string() });
const statusSchema = v.object({ connectedClients: v.number() });
const errorSchema = v.object({ error: v.string() });

let activeSseClients = 0;

function normalizeMessageInput(body: MessageInput): MessageInput {
  const content = body.content.trim();
  if (content.length === 0) {
    throw new Error(`Missing 'content' field in request body`);
  }
  return {
    content,
    role: body.role,
  };
}

function parseAgentActionBody(body: { message: string }): string {
  const value = normalizeMessageInput({
    content: body.message,
    role: undefined,
  });
  return value.content;
}

function toStreamGenerator<TEvent extends { type: string }>(
  request: Request,
  subscribe: (listener: (event: TEvent) => void) => () => void,
  mapEvent: (event: TEvent) => { event: string; data: unknown; close?: boolean },
  snapshotEvent: { event: string; data: unknown },
  initialEvents: TEvent[] = [],
): AsyncGenerator<unknown> {
  return (async function* streamGenerator() {
    activeSseClients++;

    const queue: TEvent[] = [...initialEvents];
    let resolver: (() => void) | null = null;
    let aborted = request.signal.aborted;

    const wake = () => {
      if (!resolver) return;
      resolver();
      resolver = null;
    };

    const onAbort = () => {
      aborted = true;
      wake();
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = subscribe((event) => {
      queue.push(event);
      wake();
    });

    try {
      yield sse(snapshotEvent);

      while (!aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
          continue;
        }

        const next = queue.shift();
        if (!next) continue;

        const mapped = mapEvent(next);
        yield sse({ event: mapped.event, data: mapped.data });
        if (mapped.close) return;
      }
    } finally {
      unsubscribe();
      request.signal.removeEventListener("abort", onAbort);
      activeSseClients = Math.max(0, activeSseClients - 1);
    }
  })();
}

export const app = new Elysia()
  .get(`/api/status`, () => {
    return {
      connectedClients: activeSseClients,
    };
  }, {
    response: statusSchema,
  })
  .get(`/chat/:chatId/messages`, ({ params }) => {
    return store.listChatMessages(params.chatId);
  }, {
    params: chatParamsSchema,
    response: v.array(messageSchema),
  })
  .post(`/chat/:chatId/messages`, ({ params, body }) => {
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
  .delete(`/chat/:chatId/messages`, ({ params }) => {
    store.clearChatMessages(params.chatId);
    return new Response(null, { status: 204 });
  }, {
    params: chatParamsSchema,
  })
  .get(`/chat/:chatId/messages/sse`, ({ params, request }) => {
    const stream = toStreamGenerator<StreamMessageEvent<ChatMessage>>(
      request,
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
  })
  .get(`/agent/:chatId/messages`, ({ params }) => {
    return store.listAgentMessages(params.chatId);
  }, {
    params: chatParamsSchema,
    response: v.array(agentMessageSchema),
  })
  .get(`/agent/:chatId/messages/sse`, ({ params, request }) => {
    const stream = toStreamGenerator<StreamMessageEvent<AgentMessage>>(
      request,
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
  .get(`/agent/:chatId/events/:runId`, ({ params }) => {
    return store.listAgentRunEvents(params.chatId, params.runId);
  }, {
    params: chatRunParamsSchema,
    response: v.array(agentEventSchema),
  })
  .get(`/agent/:chatId/events/:runId/sse`, ({ params, request }) => {
    const initialEvents: AgentRunEvent[] = store.isAgentRunClosed(params.chatId, params.runId)
      ? [{ type: `closed` }]
      : [];

    const stream = toStreamGenerator<AgentRunEvent>(
      request,
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
  .post(`/agent/:chatId/prompt`, async ({ params, body, set }) => {
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
  .post(`/agent/:chatId/steer`, ({ params, body, set }) => {
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
  .post(`/agent/:chatId/abort`, ({ params, set }) => {
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
  .get(`/agent/:chatId/history`, ({ params, set }) => {
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
  })
  .all(`/api/*`, ({ set }) => {
    set.status = 404;
    return { error: `Not Found` };
  }, {
    response: {
      404: errorSchema,
    },
  })
  .all(`/chat/*`, ({ set }) => {
    set.status = 404;
    return { error: `Not Found` };
  }, {
    response: {
      404: errorSchema,
    },
  })
  .all(`/agent/*`, ({ set }) => {
    set.status = 404;
    return { error: `Not Found` };
  }, {
    response: {
      404: errorSchema,
    },
  })
  .use(await staticPlugin({
    assets: STUDIO_PUBLIC,
    prefix: `/`,
    indexHTML: true,
  }))
  .onError(({ code, error, set }) => {
    if (code === `VALIDATION`) {
      set.status = 400;
      return {
        error: error.message,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes(`not found`)) set.status = 404;
    if (lower.includes(`missing`) || lower.includes(`empty`) || lower.includes(`invalid`)) {
      set.status = 400;
    }
    if (set.status === 200) set.status = 500;

    return {
      error: message,
    };
  });

export type App = typeof app;

app.listen(port);

console.log(`[server] listening on http://localhost:${port}`);
