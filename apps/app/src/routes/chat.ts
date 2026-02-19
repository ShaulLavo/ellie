/**
 * Example chat API built on top of Durable Streams.
 *
 * Clients interact with a simple REST + SSE interface — they never see
 * protocol details like offsets, producer headers, or stream lifecycle.
 *
 * Routes:
 *   POST   /chat/:chatId/messages        — send a message
 *   GET    /chat/:chatId/messages         — read all messages
 *   GET    /chat/:chatId/messages/stream  — SSE subscription
 *   DELETE /chat/:chatId                  — delete a chat
 */
import { Elysia, t } from "elysia"
import type { ServerContext } from "@ellie/durable-streams/server"
import type { StreamMessage } from "@ellie/durable-streams"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function chatStreamPath(chatId: string): string {
  return `/chat/${chatId}`
}

function decodeJsonMessage(msg: StreamMessage): { offset: string; data: unknown } {
  let text = decoder.decode(msg.data).trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }
  return { offset: msg.offset, data: JSON.parse(text) }
}

function ensureChatStream(ctx: ServerContext, path: string): void {
  if (!ctx.store.has(path)) {
    ctx.store.create(path, { contentType: `application/json` })
  }
}

export function chatRoutes(ctx: ServerContext) {
  return new Elysia({ prefix: `/chat` })
    .post(
      `/:chatId/messages`,
      async ({ params, body }) => {
        const streamPath = chatStreamPath(params.chatId)

        ensureChatStream(ctx, streamPath)

        const data = encoder.encode(JSON.stringify(body))
        const result = ctx.store.append(streamPath, data, {
          contentType: `application/json`,
        })

        const appended = `message` in result ? result.message! : result

        return { offset: appended.offset, message: body }
      },
      {
        body: t.Object({
          role: t.String(),
          content: t.String(),
        }),
      }
    )
    .get(
      `/:chatId/messages`,
      ({ params, query }) => {
        const streamPath = chatStreamPath(params.chatId)
        const after = query.after ?? undefined

        if (!ctx.store.has(streamPath)) {
          return { messages: [] as { offset: string; data: unknown }[] }
        }

        const { messages } = ctx.store.read(streamPath, after)
        const decoded = messages.map(decodeJsonMessage)

        return { messages: decoded }
      },
      {
        query: t.Object({
          after: t.Optional(t.String()),
        }),
      }
    )
    .get(
      `/:chatId/messages/stream`,
      async function* ({ params, query }) {
        const streamPath = chatStreamPath(params.chatId)
        const after = query.after

        if (!after) return

        ensureChatStream(ctx, streamPath)

        let currentOffset = after

        while (!ctx.isShuttingDown) {
          const { messages } = ctx.store.read(streamPath, currentOffset)

          for (const msg of messages) {
            const decoded = decodeJsonMessage(msg)
            yield decoded
            currentOffset = msg.offset
          }

          const result = await ctx.store.waitForMessages(
            streamPath,
            currentOffset,
            ctx.config.longPollTimeout
          )

          if (ctx.isShuttingDown) break

          if (result.streamClosed) {
            return
          }

          if (result.timedOut) {
            continue
          }

          for (const msg of result.messages) {
            const decoded = decodeJsonMessage(msg)
            yield decoded
            currentOffset = msg.offset
          }
        }
      },
      {
        query: t.Object({
          after: t.Optional(t.String()),
        }),
      }
    )
    .delete(`/:chatId`, ({ params, status, set }) => {
      const streamPath = chatStreamPath(params.chatId)

      if (!ctx.store.has(streamPath)) {
        return status(404, `Chat not found`)
      }

      ctx.store.delete(streamPath)
      set.status = 204
    })
}
