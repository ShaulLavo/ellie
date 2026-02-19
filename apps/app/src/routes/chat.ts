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
import { Elysia } from "elysia"
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
    .post(`/:chatId/messages`, async ({ params, request }) => {
      const streamPath = chatStreamPath(params.chatId)
      const body = await request.json()

      ensureChatStream(ctx, streamPath)

      const data = encoder.encode(JSON.stringify(body))
      const result = ctx.store.append(streamPath, data, {
        contentType: `application/json`,
      })

      const message = `message` in result ? result.message! : result

      return Response.json({ offset: message.offset, message: body })
    })
    .get(`/:chatId/messages/stream`, ({ params, query }) => {
      const streamPath = chatStreamPath(params.chatId)
      const after = query.after as string | undefined

      if (!after) {
        return new Response(`Missing required 'after' query parameter`, {
          status: 400,
          headers: { "content-type": `text/plain` },
        })
      }

      ensureChatStream(ctx, streamPath)

      let isConnected = true
      let controllerRef: ReadableStreamDefaultController<Uint8Array>

      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          controllerRef = controller
          ctx.activeSSEResponses.add(controller)

          let currentOffset = after

          const cleanup = () => {
            isConnected = false
            ctx.activeSSEResponses.delete(controller)
          }

          try {
            while (isConnected && !ctx.isShuttingDown) {
              const { messages } = ctx.store.read(streamPath, currentOffset)

              for (const msg of messages) {
                const decoded = decodeJsonMessage(msg)
                controller.enqueue(
                  encoder.encode(
                    `event: message\ndata: ${JSON.stringify(decoded)}\n\n`
                  )
                )
                currentOffset = msg.offset
              }

              const result = await ctx.store.waitForMessages(
                streamPath,
                currentOffset,
                ctx.config.longPollTimeout
              )

              if (ctx.isShuttingDown || !isConnected) break

              if (result.streamClosed) {
                controller.enqueue(
                  encoder.encode(`event: done\ndata: {}\n\n`)
                )
                break
              }

              if (result.timedOut) {
                controller.enqueue(encoder.encode(`: keepalive\n\n`))
                continue
              }

              for (const msg of result.messages) {
                const decoded = decodeJsonMessage(msg)
                controller.enqueue(
                  encoder.encode(
                    `event: message\ndata: ${JSON.stringify(decoded)}\n\n`
                  )
                )
                currentOffset = msg.offset
              }
            }
          } catch {
            // Client disconnected
          } finally {
            cleanup()
            try {
              controller.close()
            } catch {
              // Already closed
            }
          }
        },
        cancel() {
          isConnected = false
          ctx.activeSSEResponses.delete(controllerRef)
        },
      })

      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": `text/event-stream`,
          "cache-control": `no-cache`,
          connection: `keep-alive`,
        },
      })
    })
    .get(`/:chatId/messages`, ({ params, query }) => {
      const streamPath = chatStreamPath(params.chatId)
      const after = (query.after as string | undefined) ?? undefined

      if (!ctx.store.has(streamPath)) {
        return Response.json({ messages: [] })
      }

      const { messages } = ctx.store.read(streamPath, after)
      const decoded = messages.map(decodeJsonMessage)

      return Response.json({ messages: decoded })
    })
    .delete(`/:chatId`, ({ params }) => {
      const streamPath = chatStreamPath(params.chatId)

      if (!ctx.store.has(streamPath)) {
        return new Response(`Chat not found`, {
          status: 404,
          headers: { "content-type": `text/plain` },
        })
      }

      ctx.store.delete(streamPath)
      return new Response(null, { status: 204 })
    })
}
