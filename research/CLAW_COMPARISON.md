# Ellie vs. Claw Repos: Agent Loop Comparison

> What Ellie currently does, and what's missing to be a "full claw."

---

## What Ellie Has Today

### Core Agent Loop

Ellie has a **working in-process LLM-tool runtime loop**, which puts it in the same archetype as nanobot, openclaw, nullclaw, and zclaw (not the queue-orchestration model of tinyclaw).

**Execution path:**

```
POST /chat/:sessionId/messages
  → RealtimeStore.appendEvent('user_message')
  → AgentWatcher detects via pub/sub (zero-latency, no polling)
  → AgentManager.runAgent(sessionId, text)
  → Agent.prompt(text) → agentLoop()
  → TanStack AI chat() with maxIterations(10)
  → tool calls → wrapToolsForTanStack() → execute → re-call LLM
  → events emitted via onEvent callback → persisted to SQLite
  → SSE streams to client
```

The inner loop is a standard ReAct-style tool loop: call LLM, if tool calls → execute tools → append results → call LLM again, up to `maxTurns` (default 10). This is structurally equivalent to the core loops in nanobot, nullclaw, and zclaw.

### Tool System

Tools are defined via the `AgentTool` interface with Valibot schema validation:

- `name`, `description`, `parameters` (Valibot schema), `label`, `execute()`
- Execution emits lifecycle events: `tool_execution_start` → `tool_execution_update` → `tool_execution_end`
- A `ToolCallTracker` correlates TanStack's streaming events to execution calls
- Tools support progress callbacks via `onUpdate`

No global tool registry exists — tools are passed per-agent via `agent.setTools()`.

### Provider Abstraction

Four providers supported: `anthropic`, `openai`, `ollama`, `openrouter` (plus Groq via OpenAI-compatible adapter).

Adapter resolution is a priority cascade:

1. Anthropic OAuth token (env)
2. Anthropic bearer token (env)
3. Anthropic API key (env)
4. File-based credentials with auto-refresh
5. Groq fallback (env or file)

Unified thinking/reasoning level abstraction maps `minimal`/`low`/`medium`/`high`/`xhigh` to provider-specific options.

### Event Sourcing & Streaming

- Events persisted to SQLite via `EventStore` with monotonic sequence counters
- In-memory pub/sub via `RealtimeStore` for zero-latency broadcasting
- Dual SSE endpoints: session-level (all events) and run-level (filtered by runId)
- 19 event types covering lifecycle, messages, and tool execution
- Dual-write for backward compat: `message_end` → also writes `assistant_final`

### Session & History

- Sessions stored in SQLite with Drizzle ORM
- Full history loaded on agent creation from `user_message`, `assistant_final`, `tool_result` events
- One agent per session, one conversation per agent
- `isStreaming` flag prevents concurrent prompts per session
- Different sessions run in parallel

### Steering & Follow-Up

- `agent.steer(message)` — interrupt mid-execution, checked between tool calls
- `agent.followUp(message)` — queued after agent finishes
- Remaining tool calls skipped with error message when steered

### Error Handling (Basic)

- Context overflow detection via regex patterns (Anthropic, OpenAI, OpenRouter, Ollama)
- On `agent.prompt()` failure: error event emitted, client doesn't hang
- Partial message handling: meaningful partials kept, empty ones discarded

### Memory (Hindsight)

- Separate system with its own SQLite database
- Stores episodes, facts, entities, mental models
- Indexed by embedding + full-text search
- Injected via optional `transformContext` hook — not automatic

---

## Gap Analysis: What's Missing

### 1. Retry & Resilience (vs. openclaw, zclaw, nullclaw)

| Capability                  | openclaw                         | nullclaw                      | zclaw                           | Ellie                                                 |
| --------------------------- | -------------------------------- | ----------------------------- | ------------------------------- | ----------------------------------------------------- |
| LLM call retry with backoff | Auth profile rotation + cooldown | Retry + context-recovery pass | Exponential backoff (3 retries) | **None** (only Ollama embed has retries)              |
| Context overflow recovery   | Auto-compaction + retry          | Force compression + trim      | History rollback on failure     | **Detection only** — no recovery action               |
| Rate limit handling         | Auth profile cooldown awareness  | N/A                           | Hour/day rate limits            | **None**                                              |
| Model fallback chain        | Model + thinking level fallback  | N/A                           | N/A                             | **Anthropic → Groq only** (not a real fallback chain) |
| Error terminal event        | Lifecycle error + wait semantics | Error message to user         | "Reached max iterations"        | Error event emitted (basic)                           |

**Gap severity: HIGH.** A single transient API error kills the run with no retry. Context overflow is detected but not acted on.

### 2. Context Window Management (vs. nanobot, openclaw, nullclaw)

| Capability                       | nanobot                            | openclaw                       | nullclaw                              | Ellie                                                                 |
| -------------------------------- | ---------------------------------- | ------------------------------ | ------------------------------------- | --------------------------------------------------------------------- |
| History compaction/summarization | Async consolidation into MEMORY.md | Auto-compaction with retry     | Token-based + count-based compaction  | **None**                                                              |
| History trimming                 | Via consolidation                  | Pruning + sanitization         | Trim with system-message preservation | **None**                                                              |
| Lazy history loading             | N/A (JSONL-based)                  | Session manager with guards    | In-memory owned messages              | **Full load on creation**                                             |
| Max history bounds               | Consolidation triggers             | Context-window guard pre-check | Fixed rolling buffer                  | **Unbounded**                                                         |
| Context transform                | N/A                                | Pre-model-resolve hooks        | Memory context enrichment             | Optional `transformContext` hook (exists but not used for compaction) |

**Gap severity: HIGH.** Long conversations will overflow the context window with no mitigation. No compaction, no trimming, no bounds.

### 3. Tool Loop Safety (vs. openclaw, zclaw)

| Capability                | openclaw                                                      | zclaw                      | Ellie                                            |
| ------------------------- | ------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| Max iterations            | Configurable                                                  | MAX_TOOL_ROUNDS (5)        | maxTurns (10) via TanStack                       |
| Loop detection            | Generic repeats, poll no-progress, ping-pong, circuit breaker | Bounded by MAX_TOOL_ROUNDS | **None**                                         |
| Tool policy/filtering     | Global + provider + agent + group + subagent constraints      | GPIO safety policy         | **None** — all registered tools always available |
| Sandbox-aware execution   | Sandbox-aware fs/exec                                         | N/A                        | **None**                                         |
| Oversized result handling | Truncation fallback                                           | N/A                        | **None**                                         |

**Gap severity: MEDIUM.** The iteration cap exists (via TanStack), but there's no detection of degenerate loops (tool A → tool B → tool A...) and no tool policy layer.

### 4. Multi-Agent / Subagents (vs. nanobot, tinyclaw, openclaw)

| Capability                     | nanobot                                 | tinyclaw                        | openclaw                    | Ellie                             |
| ------------------------------ | --------------------------------------- | ------------------------------- | --------------------------- | --------------------------------- |
| Subagent spawning              | SubagentManager with own tool registry  | N/A (different model)           | Isolated runtime identities | **None**                          |
| Agent delegation               | Background subagents, result summarized | Queue fan-out/fan-in            | Per-agent workspace + auth  | **None**                          |
| Team/multi-agent orchestration | N/A                                     | `[@teammate: ...]` handoff loop | Multi-agent with lifecycle  | **None**                          |
| Agent isolation                | Process-local, own loop                 | Per-agent workspace dirs        | Workspace + auth + sessions | **Single agent per session only** |

**Gap severity: LOW-MEDIUM.** Single-agent is fine for a chat assistant. Becomes a gap if you want task decomposition, parallel research, or specialist delegation.

### 5. Session & Lifecycle Management (vs. openclaw, tinyclaw)

| Capability                 | openclaw                                            | tinyclaw                          | Ellie                                      |
| -------------------------- | --------------------------------------------------- | --------------------------------- | ------------------------------------------ |
| Run lifecycle events       | start → running → end/error with wait semantics     | N/A                               | agent_start/agent_end (basic)              |
| Run deduplication          | Request-level dedupe                                | N/A                               | **None**                                   |
| Lifecycle wait with grace  | `agent.wait` with error grace period (15s failover) | N/A                               | **None** — fire and forget                 |
| Session lane serialization | Per-session + optional global lane                  | Per-agent promise chains          | isStreaming flag (basic)                   |
| Agent eviction             | N/A                                                 | N/A                               | Deferred eviction if streaming             |
| Crash recovery             | Lifecycle terminal event guaranteed                 | Orphaned file recovery on startup | **None** — in-memory state lost on restart |

**Gap severity: MEDIUM.** No crash recovery means a server restart loses all in-flight agent state. Run deduplication and lifecycle wait would improve reliability for production use.

### 6. Persistent Memory (vs. nanobot, nullclaw)

| Capability              | nanobot                       | nullclaw                       | Ellie                                          |
| ----------------------- | ----------------------------- | ------------------------------ | ---------------------------------------------- |
| Long-term memory files  | MEMORY.md + HISTORY.md        | Memory backend handle          | Hindsight (separate, not auto-integrated)      |
| Auto-consolidation      | Async on large sessions       | Optional autosave              | **None**                                       |
| Memory-enriched prompts | ContextBuilder injects memory | Context enrichment with memory | Only via explicit `transformContext` hook      |
| Cross-session memory    | Via MEMORY/HISTORY files      | Via memory backend             | **Hindsight exists but is opt-in per request** |

**Gap severity: MEDIUM.** Hindsight is a solid memory system, but it's not automatically wired into the agent loop. The agent doesn't learn from past sessions by default.

### 7. MCP Integration (vs. none of them, but it's table stakes now)

None of the claw repos have MCP either. But TanStack AI already supports `mcp_servers` in model options for Anthropic, so Ellie is actually closer to MCP than any of them — it just hasn't been wired up.

**Gap severity: LOW** (relative to claws). **HIGH** (relative to the broader ecosystem).

### 8. Command/Control Surface (vs. nullclaw, zclaw)

| Capability            | nullclaw                  | zclaw                                              | Ellie                          |
| --------------------- | ------------------------- | -------------------------------------------------- | ------------------------------ |
| Slash commands        | `/new` (archive + reset)  | `/start`, `/help`, `/settings`, `/stop`, `/resume` | **None** — no in-chat commands |
| Pause/resume          | N/A                       | Command-level gating                               | `abort()` only (no resume)     |
| Session reset/archive | `/new` with consolidation | `/start`                                           | **None**                       |

**Gap severity: LOW.** These are UX conveniences, not architectural gaps.

### 9. Provider-Level Features (vs. openclaw)

| Capability                  | openclaw                               | Ellie                          |
| --------------------------- | -------------------------------------- | ------------------------------ |
| Auth profile rotation       | Multiple profiles with cooldown        | Single credential per provider |
| Per-session model overrides | Session-level model/thinking overrides | Server-wide adapter only       |
| Thinking level fallback     | Falls back thinking level on failure   | **None**                       |
| Pre-model-resolve hooks     | Extensible hook system                 | **None**                       |
| Skills/bootstrap context    | Skills snapshot + bootstrap files      | System prompt only             |

**Gap severity: MEDIUM.** Single-credential and no per-session model switching limits flexibility.

---

## Summary Scorecard

| Dimension                    | Ellie Status                | Closest Claw Equivalent            | Gap                            |
| ---------------------------- | --------------------------- | ---------------------------------- | ------------------------------ |
| **Core tool loop**           | Working ReAct loop          | nanobot/nullclaw/zclaw             | Small — missing loop detection |
| **Provider abstraction**     | 4 providers + cascade       | openclaw (deeper)                  | Medium — no fallback chains    |
| **Event sourcing**           | SQLite + pub/sub + SSE      | Unique to Ellie                    | Ellie is ahead here            |
| **Streaming**                | Full chunk-level streaming  | openclaw (comparable)              | Small                          |
| **Retry/resilience**         | Almost none                 | openclaw (gold standard)           | **Large**                      |
| **Context management**       | Detection only              | nanobot/nullclaw (compaction)      | **Large**                      |
| **Tool safety**              | Iteration cap only          | openclaw (loop detection + policy) | Medium                         |
| **Multi-agent**              | None                        | nanobot/openclaw                   | Medium-Large                   |
| **Memory integration**       | Hindsight exists, not wired | nanobot (auto-consolidation)       | Medium                         |
| **Lifecycle/crash recovery** | None                        | openclaw/tinyclaw                  | Medium                         |
| **MCP**                      | None (but closest to it)    | None of them                       | Low vs. claws                  |

---

## Priority Roadmap (if building toward "full claw")

### Phase 1: Don't crash on predictable failures

1. **LLM retry with backoff** — wrap `chat()` calls with configurable retry (like zclaw's 3x exponential)
2. **Context overflow recovery** — when overflow detected, compact/trim history and retry
3. **Oversized tool result truncation** — cap tool results before they blow the context

### Phase 2: Don't degrade over long conversations

4. **History compaction** — summarize old messages when approaching context limit (like nanobot's consolidation)
5. **History bounds** — max message count or token budget, trim oldest non-system messages
6. **Wire Hindsight into the loop** — auto-inject relevant memories via `transformContext`

### Phase 3: Production robustness

7. **Tool loop detection** — detect repeated tool patterns and break (like openclaw's detectors)
8. **Run deduplication** — prevent double-prompting at the API level
9. **Crash recovery** — persist enough run state to resume or gracefully fail on restart
10. **Rate limit awareness** — detect 429s and back off per-provider

### Phase 4: Power features

11. **Per-session model selection** — allow switching models mid-conversation
12. **Model fallback chains** — try model A, fall back to B on failure
13. **MCP tool discovery** — leverage TanStack's existing `mcp_servers` support
14. **Subagent delegation** — spawn focused sub-loops for tool-heavy tasks

---

## Ellie's Unique Strengths (Things the Claws Don't Have)

1. **Event sourcing with real-time pub/sub** — none of the claws have this level of event persistence + live streaming. Nanobot uses JSONL, nullclaw is in-memory, zclaw is a fixed buffer. Ellie's SQLite event store with RealtimeStore is architecturally superior for replay, debugging, and multi-client sync.

2. **Structured dual-write events** — backward-compatible event mapping (`message_end` → `assistant_final`) shows production thinking about schema evolution.

3. **Steering mid-execution** — the ability to interrupt tool execution with a new user message and redirect the agent is not present in any claw repo.

4. **Valibot-validated tool schemas** — type-safe tool parameter validation at the boundary. The claws use JSON Schema or nothing.

5. **Thinking level abstraction** — unified `minimal`/`low`/`medium`/`high`/`xhigh` mapped per-provider. No claw has this.

6. **Hindsight memory system** — episodes, facts, entities, mental models with embedding search. Far more sophisticated than nanobot's MEMORY.md files. Just needs to be wired into the loop.

7. **OAuth credential management** — auto-refreshing Anthropic OAuth with file-based multi-provider storage. The claws use env vars only.
