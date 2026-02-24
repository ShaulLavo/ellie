import type { AgentEvent, AgentMessage } from "@ellie/agent"
import type { EventStore, EventRow, EventType } from "@ellie/db"

export type AgentRunEvent =
  | { type: "event"; event: AgentEvent }
  | { type: "closed" }

export type SessionEvent =
  | { type: "append"; event: EventRow }
  | { type: "run_closed"; runId: string }

type Listener<T> = (event: T) => void

export class RealtimeStore {
  readonly #store: EventStore
  readonly #listeners = new Map<string, Set<Listener<unknown>>>()
  readonly #closedRuns = new Set<string>()

  constructor(store: EventStore) {
    this.#store = store
  }

  get eventStore(): EventStore {
    return this.#store
  }

  // ── Session CRUD ──────────────────────────────────────────────────────

  ensureSession(sessionId: string): void {
    if (!this.#store.getSession(sessionId)) {
      this.#store.createSession(sessionId)
    }
  }

  // ── Event append (with live notification) ─────────────────────────────

  appendEvent(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
    runId?: string,
    dedupeKey?: string
  ): EventRow {
    const row = this.#store.append({ sessionId, type, payload, runId, dedupeKey })

    // Notify session-level subscribers
    this.#publish(`session:${sessionId}`, {
      type: "append",
      event: row,
    } satisfies SessionEvent)

    // If this is a run_closed, also notify run-specific subscribers
    if (type === "run_closed" && runId) {
      this.#closedRuns.add(this.#runKey(sessionId, runId))
      this.#publish(this.#runChannel(sessionId, runId), {
        type: "closed",
      } satisfies AgentRunEvent)
    }

    return row
  }

  // ── Agent run lifecycle ───────────────────────────────────────────────

  appendAgentRunEvent(
    sessionId: string,
    runId: string,
    event: AgentEvent
  ): void {
    // Map agent events to persisted event types
    const mapping = this.#mapAgentEvent(event)
    if (mapping) {
      this.#store.append({
        sessionId,
        type: mapping.type,
        payload: mapping.payload,
        runId,
      })
    }

    // Always publish live to run subscribers (even for non-persisted events like deltas)
    this.#publish(this.#runChannel(sessionId, runId), {
      type: "event",
      event,
    } satisfies AgentRunEvent)
  }

  closeAgentRun(sessionId: string, runId: string): void {
    this.appendEvent(sessionId, "run_closed", { reason: "completed" }, runId)
  }

  isAgentRunClosed(sessionId: string, runId: string): boolean {
    return this.#closedRuns.has(this.#runKey(sessionId, runId))
  }

  // ── Query wrappers ────────────────────────────────────────────────────

  listAgentMessages(sessionId: string): AgentMessage[] {
    return this.#store.getConversationHistory(sessionId) as unknown as AgentMessage[]
  }

  queryEvents(sessionId: string, afterSeq?: number, types?: EventType[]) {
    return this.#store.query({ sessionId, afterSeq, types })
  }

  queryRunEvents(sessionId: string, runId: string) {
    return this.#store.query({ sessionId, runId })
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  subscribeToSession(
    sessionId: string,
    listener: Listener<SessionEvent>
  ): () => void {
    return this.#subscribe(`session:${sessionId}`, listener)
  }

  subscribeToAgentRun(
    sessionId: string,
    runId: string,
    listener: Listener<AgentRunEvent>
  ): () => void {
    return this.#subscribe(this.#runChannel(sessionId, runId), listener)
  }

  // ── Private ───────────────────────────────────────────────────────────

  #mapAgentEvent(
    event: AgentEvent
  ): { type: EventType; payload: Record<string, unknown> } | null {
    switch (event.type) {
      case "agent_start":
        return { type: "agent_start", payload: {} }
      case "agent_end":
        return { type: "agent_end", payload: { messages: event.messages } }
      case "turn_start":
        return { type: "turn_start", payload: {} }
      case "turn_end":
        return {
          type: "turn_end",
          payload: {},
        }
      case "message_end":
        // Persist the final message based on its role
        if (event.message.role === "assistant") {
          return {
            type: "assistant_final",
            payload: event.message as unknown as Record<string, unknown>,
          }
        }
        return null
      case "tool_execution_end":
        return {
          type: "tool_result",
          payload: {
            role: "toolResult",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content: event.result.content,
            details: event.result.details,
            isError: event.isError,
            timestamp: Date.now(),
          },
        }
      // Non-persisted events (message_start, message_update, tool_execution_start, etc.)
      default:
        return null
    }
  }

  #runKey(sessionId: string, runId: string): string {
    return `${sessionId}:${runId}`
  }

  #runChannel(sessionId: string, runId: string): string {
    return `run:${sessionId}:${runId}`
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
