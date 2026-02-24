import type { AgentEvent, AgentMessage } from "@ellie/agent"
import { typedLog, type JsonlEngine } from "@ellie/db"
import { agentEventSchema, agentMessageSchema } from "@ellie/schemas/agent"
import { messageSchema } from "@ellie/schemas/router"
import type { GenericSchema, InferOutput } from "valibot"

export type ChatMessage = InferOutput<typeof messageSchema>

export type StreamMessageEvent<T> =
  | { type: "append"; message: T }
  | { type: "clear" }

export type AgentRunEvent =
  | { type: "event"; event: AgentEvent }
  | { type: "closed" }

type Listener<T> = (event: T) => void

const CHAT_MESSAGE_SCHEMA_KEY = "app-chat-message"
const AGENT_MESSAGE_SCHEMA_KEY = "app-agent-message"
const AGENT_EVENT_SCHEMA_KEY = "app-agent-event"

const JSON_CONTENT_TYPE = "application/json"

export class RealtimeStore {
  readonly #engine: JsonlEngine
  readonly #listeners = new Map<string, Set<Listener<unknown>>>()
  readonly #closedAgentRunChannels = new Set<string>()

  constructor(engine: JsonlEngine) {
    this.#engine = engine
    this.#engine.registerSchema(CHAT_MESSAGE_SCHEMA_KEY, messageSchema)
    this.#engine.registerSchema(AGENT_MESSAGE_SCHEMA_KEY, agentMessageSchema)
    this.#engine.registerSchema(AGENT_EVENT_SCHEMA_KEY, agentEventSchema)
  }

  listChatMessages(chatId: string): ChatMessage[] {
    return this.#readStream(
      this.#chatMessagesPath(chatId),
      messageSchema,
      CHAT_MESSAGE_SCHEMA_KEY
    )
  }

  appendChatMessage(chatId: string, message: ChatMessage): void {
    this.#appendStream(
      this.#chatMessagesPath(chatId),
      messageSchema,
      CHAT_MESSAGE_SCHEMA_KEY,
      message
    )
    this.#publish(this.#chatChannel(chatId), { type: "append", message } satisfies StreamMessageEvent<ChatMessage>)
  }

  clearChatMessages(chatId: string): void {
    this.#engine.deleteStream(this.#chatMessagesPath(chatId))
    this.#publish(this.#chatChannel(chatId), { type: "clear" } satisfies StreamMessageEvent<ChatMessage>)
  }

  subscribeToChatMessages(
    chatId: string,
    listener: Listener<StreamMessageEvent<ChatMessage>>
  ): () => void {
    return this.#subscribe(this.#chatChannel(chatId), listener)
  }

  hasAgentMessages(chatId: string): boolean {
    return this.#hasStream(this.#agentMessagesPath(chatId))
  }

  ensureAgentMessages(chatId: string): void {
    this.#createStreamIfMissing(this.#agentMessagesPath(chatId), AGENT_MESSAGE_SCHEMA_KEY)
  }

  listAgentMessages(chatId: string): AgentMessage[] {
    return this.#readStream(
      this.#agentMessagesPath(chatId),
      agentMessageSchema,
      AGENT_MESSAGE_SCHEMA_KEY
    ) as AgentMessage[]
  }

  appendAgentMessage(chatId: string, message: AgentMessage): void {
    this.#appendStream(
      this.#agentMessagesPath(chatId),
      agentMessageSchema,
      AGENT_MESSAGE_SCHEMA_KEY,
      message
    )
    this.#publish(this.#agentMessagesChannel(chatId), {
      type: "append",
      message,
    } satisfies StreamMessageEvent<AgentMessage>)
  }

  subscribeToAgentMessages(
    chatId: string,
    listener: Listener<StreamMessageEvent<AgentMessage>>
  ): () => void {
    return this.#subscribe(this.#agentMessagesChannel(chatId), listener)
  }

  createAgentRun(chatId: string, runId: string, ttlSeconds: number): void {
    this.#createStreamIfMissing(
      this.#agentRunPath(chatId, runId),
      AGENT_EVENT_SCHEMA_KEY,
      ttlSeconds
    )
    this.#closedAgentRunChannels.delete(this.#agentRunChannel(chatId, runId))
  }

  listAgentRunEvents(chatId: string, runId: string): AgentEvent[] {
    return this.#readStream(
      this.#agentRunPath(chatId, runId),
      agentEventSchema,
      AGENT_EVENT_SCHEMA_KEY
    ) as AgentEvent[]
  }

  appendAgentRunEvent(chatId: string, runId: string, event: AgentEvent): void {
    this.#appendStream(
      this.#agentRunPath(chatId, runId),
      agentEventSchema,
      AGENT_EVENT_SCHEMA_KEY,
      event
    )
    this.#publish(this.#agentRunChannel(chatId, runId), {
      type: "event",
      event,
    } satisfies AgentRunEvent)
  }

  closeAgentRun(chatId: string, runId: string): void {
    const channel = this.#agentRunChannel(chatId, runId)
    this.#closedAgentRunChannels.add(channel)
    this.#publish(channel, { type: "closed" } satisfies AgentRunEvent)
  }

  isAgentRunClosed(chatId: string, runId: string): boolean {
    return this.#closedAgentRunChannels.has(this.#agentRunChannel(chatId, runId))
  }

  subscribeToAgentRun(
    chatId: string,
    runId: string,
    listener: Listener<AgentRunEvent>
  ): () => void {
    return this.#subscribe(this.#agentRunChannel(chatId, runId), listener)
  }

  #chatMessagesPath(chatId: string): string {
    return `/chat/${chatId}/messages`
  }

  #agentMessagesPath(chatId: string): string {
    return `/agent/${chatId}/messages`
  }

  #agentRunPath(chatId: string, runId: string): string {
    return `/agent/${chatId}/events/${runId}`
  }

  #chatChannel(chatId: string): string {
    return `chat:${chatId}:messages`
  }

  #agentMessagesChannel(chatId: string): string {
    return `agent:${chatId}:messages`
  }

  #agentRunChannel(chatId: string, runId: string): string {
    return `agent:${chatId}:run:${runId}`
  }

  #hasStream(path: string): boolean {
    return this.#engine.getStream(path) !== undefined
  }

  #createStreamIfMissing(path: string, schemaKey: string, ttlSeconds?: number): void {
    if (this.#hasStream(path)) return
    this.#engine.createStream(path, {
      contentType: JSON_CONTENT_TYPE,
      schemaKey,
      ttlSeconds,
    })
  }

  #readStream<S extends GenericSchema>(
    path: string,
    schema: S,
    schemaKey: string
  ): InferOutput<S>[] {
    if (!this.#hasStream(path)) return []
    const log = typedLog(this.#engine, path, schema, {
      contentType: JSON_CONTENT_TYPE,
      schemaKey,
    })
    return log.read({ validate: true }).map((record) => record.data)
  }

  #appendStream<S extends GenericSchema>(
    path: string,
    schema: S,
    schemaKey: string,
    value: InferOutput<S>
  ): void {
    const log = typedLog(this.#engine, path, schema, {
      contentType: JSON_CONTENT_TYPE,
      schemaKey,
    })
    log.append(value)
  }

  #publish<T>(channel: string, event: T): void {
    const listeners = this.#listeners.get(channel)
    if (!listeners) return
    for (const listener of listeners) {
      ;(listener as Listener<T>)(event)
    }
  }

  #subscribe<T>(channel: string, listener: Listener<T>): () => void {
    let listeners = this.#listeners.get(channel)
    if (!listeners) {
      listeners = new Set<Listener<unknown>>()
      this.#listeners.set(channel, listeners)
    }

    listeners.add(listener as Listener<unknown>)

    return () => {
      const existing = this.#listeners.get(channel)
      if (!existing) return
      existing.delete(listener as Listener<unknown>)
      if (existing.size !== 0) return
      this.#listeners.delete(channel)
    }
  }
}
