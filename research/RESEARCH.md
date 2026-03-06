# Personal AI Assistants — Comparative Architecture Research

Last updated: 2026-02-21  
Scope: `bot`, `LocalAGI`, `khoj`, `letta-code`, `nanobot`, `nullclaw`, `openclaw`, `tinyclaw`

---

## 0) Executive Summary

- `bot` and `openclaw` are the most complete full-stack agent runtimes (loop control, sessioning, compaction, heartbeat, and strong delivery pipelines).
- `letta-code` is strongest on CLI-side recovery/approval orchestration, with compaction behavior mostly server-originated and streamed to the client.
- `nullclaw` has strong core architecture (loop, compaction, memory backends), but heartbeat has two in-repo paths that are not currently connected: `HeartbeatEngine` parses `HEARTBEAT.md`, while daemon heartbeat only does state/health ticks.
- `tinyclaw` is operationally simple and pragmatic (queue + provider CLIs: `codex`, Claude Code `claude`, OpenCode `opencode`), but many core capabilities (memory/compaction/session durability) are delegated to those provider CLIs.
- `khoj` and `LocalAGI` have robust domain-specific strengths (research loop and scheduled autonomous jobs), with less emphasis on unified agent session branching/compaction ergonomics.

---

## 1) Normalized Comparison Method

To keep this research consistent, every repo is compared on the same feature set:

- **Loop Model**: how turns are executed, retried, and terminated.
- **Tool Runtime**: tool-call protocol, execution model, and orchestration.
- **Session Model**: persistence format, resume model, branching, eviction.
- **Context Management**: pruning, compaction, overflow handling.
- **Memory Model**: long-term storage, retrieval path, write triggers.
- **Bootstrap / Identity**: workspace seeding, identity sources, initial prompting.
- **Heartbeat / Autonomy**: periodic wakeups, ack semantics, scheduling.
- **Streaming / Delivery**: live output protocol and delivery layer.
- **Integration Surface**: MCP, channels, subagents/teams, approval controls.

Legend:

- `✅` implemented and clearly wired in runtime path
- `⚠️` implemented but partial/delegated/indirect
- `❌` not found in current codebase trace
- `🧪` exists as module/prototype, runtime wiring still needs validation

---

## 2) Repo Snapshot

| Repo         | Primary stack           | Core runtime shape                                                 | Where to start                                                                   |
| ------------ | ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `bot`        | TypeScript + Bun        | Orchestrator + typed event stream                                  | `bot/packages/agent/src/orchestrator.ts`, `bot/packages/agent/src/agent-loop.ts` |
| `LocalAGI`   | Go                      | Job queue + periodic/scheduled runs                                | `LocalAGI/core/agent/agent.go`                                                   |
| `khoj`       | Python + Django/FastAPI | Iterative research planner + tool runners                          | `khoj/src/khoj/routers/research.py`                                              |
| `letta-code` | TypeScript/Node         | Stream-driven headless CLI loop with approval recovery             | `letta-code/src/headless.ts`                                                     |
| `nanobot`    | Python                  | ReAct-like loop over tool calls                                    | `nanobot/nanobot/agent/loop.py`                                                  |
| `nullclaw`   | Zig                     | Agent + session manager + pluggable subsystems                     | `nullclaw/src/agent/root.zig`, `nullclaw/src/session.zig`                        |
| `openclaw`   | TypeScript/Node         | Queue/followup runner with durable session store                   | `openclaw/src/auto-reply/reply/agent-runner.ts`                                  |
| `tinyclaw`   | TypeScript + Bash       | File-queue router to provider CLIs (`codex`, `claude`, `opencode`) | `tinyclaw/src/queue-processor.ts`, `tinyclaw/src/lib/invoke.ts`                  |

---

## 3) Matrix A — Loop, Tools, Sessions, Context

| Feature                             | `bot`                                                         | `LocalAGI`                                                  | `khoj`                                                     | `letta-code`                                                                  | `nanobot`                                                  | `nullclaw`                                                             | `openclaw`                                                                     | `tinyclaw`                                                |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **Loop engine**                     | ✅ EventStream loop + orchestrator turn control               | ✅ Job queue + workers + periodic autonomous jobs           | ✅ Iterative research tool loop                            | ✅ Stream-drain loop with retries/recovery                                    | ✅ Iterative tool loop (`max_iterations`)                  | ✅ Iterative turn loop with native/XML tool-call parsing               | ✅ Reply runner + followup/queue loop                                          | ✅ Queue processor dispatch loop                          |
| **Tool call protocol**              | ✅ Structured tool events (`tool-call`/`tool-result`)         | ✅ Action definitions and typed params                      | ✅ `ToolCall` / `ConversationCommand` model                | ✅ Streaming tool events + approval chunks                                    | ✅ Function-style tool calls via provider                  | ✅ Native `tool_calls` + canonical XML history fallback                | ✅ PI tool events + command queue integration                                  | ⚠️ Delegated to Claude/Codex/OpenCode CLI                 |
| **Parallel tool execution in-turn** | ⚠️ Not explicit as parallel in current loop path              | ⚠️ Parallel workers/jobs, not explicit per-turn tool fanout | ✅ Parallelizable tools via `asyncio.gather`               | ⚠️ Parallel approval/result handling, model-dependent tool fanout             | ❌ Sequential per turn                                     | ❌ Sequential per turn                                                 | ⚠️ Queue/followup concurrency; per-turn mostly serial                          | ✅ Concurrent team/agent queue processing                 |
| **Subagent / delegation model**     | ✅ Spawnable agent support                                    | ⚠️ Multi-agent pool (no nested tool-spawn tree found)       | ⚠️ Tool-AI routing but not persistent spawned worker graph | ⚠️ Subagent prompt presets; deeper runtime delegation validation still useful | ✅ `spawn` tool + subagent manager                         | ✅ Delegate/spawn tools exposed                                        | ✅ Agent scope + spawned routing metadata                                      | ✅ Team mentions enqueue internal agent-to-agent messages |
| **Session persistence**             | ✅ Feed logs + metadata store                                 | ⚠️ State file + optional conversation saves                 | ✅ DB `Conversation.conversation_log`                      | ✅ Agent/conversation IDs with resume/new flows                               | ✅ JSONL session files                                     | ⚠️ Persistent in-process sessions (not durable across process restart) | ✅ `sessions.json` + JSONL transcripts                                         | ✅ Queue files + per-agent provider session continuation  |
| **Session branching/forking**       | ✅ Explicit tree, branch switch, fork, resume APIs            | ❌                                                          | ❌                                                         | ⚠️ Multiple conversations; no tree branch API                                 | ❌                                                         | ❌                                                                     | ⚠️ Session-key partitioning (no explicit tree branch API in inspected runtime) | ❌                                                        |
| **Context compaction/pruning**      | ✅ Token-aware context trimming + pre-compaction memory flush | ❌ No dedicated compaction layer found                      | ✅ Token-based message truncation                          | ⚠️ Handles overflow stop reasons + recovery policies                          | ⚠️ Consolidation exists, history intentionally append-only | ✅ Auto-compaction + force compression                                 | ✅ Auto/manual compaction + safeguards/audits                                  | ❌ Not found (largely delegated to provider CLI behavior) |
| **Streaming to client surfaces**    | ✅ NDJSON catch-up + SSE live stream with offset replay       | ✅ SSE manager with history replay                          | ✅ Chat event stream (`ChatEvent`)                         | ✅ `stream-json` events with run/seq tracking                                 | ⚠️ Progress callbacks + outbound bus                       | ✅ Provider streaming callbacks and gateway channel streaming          | ✅ Block streaming + typed event pipeline                                      | ❌ Queue polling (non-SSE)                                |

---

## 4) Matrix B — Memory, Bootstrap, Identity, Prompt Surface

| Feature                          | `bot`                                                        | `LocalAGI`                                                 | `khoj`                                                        | `letta-code`                                      | `nanobot`                                              | `nullclaw`                                                                                                      | `openclaw`                                               | `tinyclaw`                                             |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| **Long-term memory backend**     | ✅ External memory service (retain/recall/reflect/summarize) | ✅ RAG DB + summary/long-term modes                        | ✅ `UserMemory` + pgvector                                    | ✅ Managed memory blocks + optional git memfs     | ✅ File memory (`MEMORY.md` + `HISTORY.md`)            | ✅ Memory vtable: sqlite/markdown/lucid/none                                                                    | ✅ Workspace memory files + memory tools/flush           | ⚠️ Delegated to provider conversation + workspace docs |
| **Retrieval path into prompt**   | ✅ Recall integrated into system prompt build                | ✅ KB lookup injects system memory context                 | ✅ Relevant memories/context inserted in chat generation path | ✅ Memory reminder and memory prompt assets       | ✅ Memory context section in system prompt builder     | ✅ Memory recall and workspace identity files injected                                                          | ✅ Bootstrap context resolver + system prompt builder    | ⚠️ Via AGENTS/workspace docs and provider CLI state    |
| **Memory write strategy**        | ✅ Explicit retain/reflect/summarize endpoints               | ✅ Store messages/summaries based on storage mode          | ✅ Saves convo + updates user memories                        | ✅ Block updates + memfs git workflows            | ✅ Append history + long-term file writes              | ⚠️ Backend auto-save + store APIs wired; memory tools are initialized without backend in inspected runtime path | ✅ Memory flush + tools + workspace files                | ⚠️ Mostly provider session memory + file edits         |
| **Workspace bootstrap seeding**  | ✅ Template files and first-turn bootstrap injection         | ⚠️ Identity prep/stateful init, not workspace-file seeding | ❌ Not workspace-file bootstrap centric                       | ✅ Agent creation pipeline initializes core setup | ✅ Template workspace includes core docs and heartbeat | ✅ `scaffoldWorkspace` writes core files                                                                        | ✅ `ensureAgentWorkspace` seeds templates/state          | ✅ `ensureAgentDirectory` copies templates/symlinks    |
| **Interactive setup/onboarding** | ⚠️ Config-driven, not a dedicated wizard focus               | ⚠️ Config/options centric                                  | ✅ Product onboarding in app flow                             | ✅ Rich CLI initialization/resume modes           | ⚠️ Config-first                                        | ✅ `onboard` interactive + non-interactive                                                                      | ✅ `openclaw onboard` flows                              | ✅ Bash setup wizard                                   |
| **Identity source of truth**     | ✅ Workspace files + runtime prompt builder                  | ⚠️ Character struct (optionally LLM-generated)             | ✅ Agent DB personality and prompt templates                  | ✅ Prompt preset system + memory/persona assets   | ✅ SOUL/AGENTS/USER files + runtime identity section   | ✅ Workspace identity files + optional AIEOS JSON format                                                        | ✅ AGENTS/SOUL/IDENTITY/USER + system prompt composition | ✅ AGENTS/SOUL + per-agent workspace docs              |
| **Prompt assets externalized**   | ✅ Templates + prompt builder module                         | ✅ Template strings (`templates.go`)                       | ✅ Central prompt module (`prompts.py`)                       | ✅ Prompt asset bundle (`promptAssets.ts`)        | ✅ Workspace markdown templates                        | ✅ Prompt builder + onboarding templates                                                                        | ✅ Docs templates + runtime prompt builders              | ✅ Workspace markdown + heartbeat template             |

---

## 5) Matrix C — Heartbeat, Scheduling, MCP, Control

| Feature                           | `bot`                                                                     | `LocalAGI`                                              | `khoj`                                            | `letta-code`                                                        | `nanobot`                                 | `nullclaw`                                                                                                                      | `openclaw`                                                                                                          | `tinyclaw`                                                   |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Heartbeat mechanism**           | ✅ Heartbeat prompt/config + runtime handling                             | ⚠️ Autonomous periodic runs (not `HEARTBEAT.md`-driven) | ❌                                                | ❌                                                                  | ✅ `HeartbeatService` with periodic ticks | ⚠️ `HeartbeatEngine` parses `HEARTBEAT.md`, but daemon heartbeat thread is state/health flush (task execution not daemon-wired) | ✅ Dedicated heartbeat runner with per-agent config                                                                 | ✅ `heartbeat-cron.sh` queues periodic checks                |
| **Heartbeat ack token semantics** | ✅ `HEARTBEAT_OK` stripping/suppression                                   | ❌                                                      | ❌                                                | ❌                                                                  | ✅ `HEARTBEAT_OK` handling                | ❌ (task-list heartbeat model, no token ack path found)                                                                         | ✅ `HEARTBEAT_OK` + short-ack suppression                                                                           | ❌ no explicit token-strip/suppress path found               |
| **Scheduler / cron primitives**   | ⚠️ Not a first-class cron subsystem in inspected files                    | ✅ Task scheduler + reminder actions                    | ⚠️ Automation/scheduling support in platform flow | ⚠️ Recovery/retry loops, no dedicated cron layer in inspected files | ✅ Cron tool/service integration          | ✅ Cron scheduler and cron tools                                                                                                | ✅ Cron/system-event integrations in gateway flow                                                                   | ✅ Heartbeat cron script; reminder commands via provider CLI |
| **MCP integration**               | ❌                                                                        | ✅ MCP sessions/actions                                 | ✅ MCP stdio + SSE client wrapper                 | ❌ (not found in inspected runtime path)                            | ✅ MCP tool wrappers/registry             | ✅ MCP stdio JSON-RPC client + wrappers                                                                                         | ⚠️ ACP bridge exists, but MCP server ingestion is disabled (`mcpCapabilities` false; incoming `mcpServers` ignored) | ❌                                                           |
| **Human approval controls**       | ⚠️ Tool policy/sandboxing exists but no deep approval state machine found | ❌                                                      | ❌                                                | ✅ Strong approval + conflict recovery flow                         | ❌                                        | ⚠️ Security/policy heavy; interactive approval loop not central in inspected path                                               | ✅ Command/approval routing patterns present                                                                        | ❌                                                           |

---

## 6) Per-Repo Normalized Profiles (Same Fields)

### `bot`

- **Loop**: `agentLoop` emits typed events; orchestrator owns persistence/broadcast/cancellation.
- **Sessions**: Durable feed logs with branch tree, fork, session list, resume endpoints.
- **Context**: token-aware context build plus pre-compaction memory flush.
- **Memory**: external memory service (`recall`/`retain`/`reflect`/`summarize-session`).
- **Bootstrap**: first-turn `BOOTSTRAP.md` injection as synthetic workspace tool call/result.
- **Heartbeat**: configurable heartbeat prompt + `HEARTBEAT_OK` suppression path.
- **Streaming**: NDJSON catch-up + SSE live with signed offsets.
- **Evidence**: `bot/packages/agent/src/agent-loop.ts`, `bot/packages/agent/src/orchestrator.ts`, `bot/apps/server/src/routes/sessions.ts`, `bot/apps/server/src/streams/router.ts`, `bot/apps/server/src/ai/system-prompt.ts`, `bot/apps/server/src/ai/heartbeat.ts`.

### `LocalAGI`

- **Loop**: job queue workers consume jobs; periodic autonomous jobs via `innerMonologueTemplate`.
- **Sessions**: agent internal state persisted via state file; optional conversation export path.
- **Context**: no dedicated compaction module found.
- **Memory**: KB search/inject + long-term/summary persistence options.
- **Bootstrap**: identity preparation supports generated character and persisted character file.
- **Heartbeat/autonomy**: autonomous periodic run model instead of explicit `HEARTBEAT.md` loop.
- **Streaming**: SSE manager with broadcast + history replay.
- **Evidence**: `LocalAGI/core/agent/agent.go`, `LocalAGI/core/agent/templates.go`, `LocalAGI/core/agent/knowledgebase.go`, `LocalAGI/core/agent/state.go`, `LocalAGI/core/sse/sse.go`, `LocalAGI/core/agent/identity.go`.

### `khoj`

- **Loop**: research planner chooses tool calls per iteration, supports interrupts/new instructions.
- **Sessions**: conversation log persisted in DB JSON (`Conversation.conversation_log`).
- **Context**: token-budget truncation in message construction path.
- **Memory**: `UserMemory` vector-backed facts + contextual retrieval.
- **Bootstrap**: personality/agent/tool configuration is DB-centric (not workspace-bootstrap centric).
- **Heartbeat/autonomy**: no heartbeat module found in inspected scope.
- **Streaming**: event protocol with explicit `END_EVENT` sentinel.
- **Special**: parallel tool execution for non-streaming tools via `asyncio.gather`.
- **Evidence**: `khoj/src/khoj/routers/research.py`, `khoj/src/khoj/processor/conversation/utils.py`, `khoj/src/khoj/database/models/__init__.py`, `khoj/src/khoj/processor/tools/mcp.py`.

### `letta-code`

- **Loop**: stream-drain loop with robust pre-stream conflict handling and retry policies.
- **Sessions**: agent + conversation IDs, continue/new/conversation targeting, stream JSON session metadata.
- **Context**: overflow/recovery handling is explicit; deeper compaction responsibility appears backend-coupled.
- **Memory**: memory blocks + reminders + optional git-backed memfs workflow.
- **Bootstrap**: `createAgent` supports model/prompt presets and base-tool recovery.
- **Heartbeat/autonomy**: no first-class heartbeat module in inspected CLI path.
- **Streaming**: run/seq tracking, optional resume on disconnect, multi-approval chunk handling.
- **Evidence**: `letta-code/src/headless.ts`, `letta-code/src/cli/helpers/stream.ts`, `letta-code/src/cli/helpers/streamProcessor.ts`, `letta-code/src/agent/create.ts`, `letta-code/src/agent/memoryGit.ts`, `letta-code/src/agent/promptAssets.ts`.

### `nanobot`

- **Loop**: iterative tool loop over provider chat responses.
- **Sessions**: JSONL session files with metadata and cache invalidation; `/new` clears and consolidates.
- **Context**: append-only message history; consolidation writes summaries to memory files.
- **Memory**: two-layer file memory (`MEMORY.md`, `HISTORY.md`).
- **Bootstrap**: workspace templates for AGENTS/SOUL/TOOLS/USER/HEARTBEAT.
- **Heartbeat**: periodic service reads `HEARTBEAT.md` and suppresses no-op responses via token checks.
- **MCP**: MCP server connections and wrapped MCP tools in registry.
- **Evidence**: `nanobot/nanobot/agent/loop.py`, `nanobot/nanobot/agent/context.py`, `nanobot/nanobot/agent/memory.py`, `nanobot/nanobot/session/manager.py`, `nanobot/nanobot/heartbeat/service.py`, `nanobot/nanobot/agent/tools/mcp.py`, `nanobot/workspace/`.

### `nullclaw`

- **Loop**: bounded tool-iteration loop with structured tool calls and XML fallback parser.
- **Sessions**: per-session in-process `SessionManager` with locking and idle eviction.
- **Context**: automatic history compaction with summarization + force-compress recovery.
- **Memory**: pluggable memory backends (`sqlite`, `markdown`, `lucid`, `none`) and memory tools.
- **Bootstrap**: onboarding scaffolds workspace identity/memory files.
- **Heartbeat**: both are in-repo: `HeartbeatEngine` reads task bullets in `HEARTBEAT.md`, while daemon heartbeat currently handles only state/health flush (it does not execute `HEARTBEAT.md` tasks).
- **Identity**: supports markdown identity files and AIEOS JSON identity format.
- **MCP**: stdio JSON-RPC client, tool discovery, wrapper registration.
- **Evidence**: `nullclaw/src/agent/root.zig`, `nullclaw/src/session.zig`, `nullclaw/src/memory/root.zig`, `nullclaw/src/agent/prompt.zig`, `nullclaw/src/onboard.zig`, `nullclaw/src/heartbeat.zig`, `nullclaw/src/mcp.zig`, `nullclaw/src/identity.zig`.

### `openclaw`

- **Loop**: high-control reply runner with followup queueing, retries, and post-compaction checks.
- **Sessions**: durable store + transcript files, reset policies, scoped session keys.
- **Context**: explicit compaction and safeguard/audit hooks.
- **Memory**: workspace memory files + memory flush and memory tooling.
- **Bootstrap**: workspace seeding with template/state tracking.
- **Heartbeat**: per-agent heartbeat scheduling, active hours, target routing, ack suppression.
- **Streaming**: block streaming with typed chunk handling and delivery adapters.
- **Evidence**: `openclaw/src/auto-reply/reply/session.ts`, `openclaw/src/auto-reply/reply/agent-runner.ts`, `openclaw/src/infra/heartbeat-runner.ts`, `openclaw/src/auto-reply/heartbeat.ts`, `openclaw/src/agents/workspace.ts`, `openclaw/docs/reference/session-management-compaction.md`, `openclaw/docs/concepts/system-prompt.md`.

### `tinyclaw`

- **Loop**: file-based queue processor routes to agents and handles internal team message fan-out.
- **Sessions**: provider CLI continuation via `claude` (Claude Code), `codex`, and `opencode` (`claude -c`, `codex exec resume --last`, `opencode -c`) per agent workspace.
- **Context**: no native compaction layer found.
- **Memory**: mostly delegated to provider conversation state + workspace markdown docs.
- **Bootstrap**: setup wizard + per-agent directory templating (`.claude`, `AGENTS.md`, `heartbeat.md`, `SOUL.md`).
- **Heartbeat**: cron loop queues heartbeat prompts to each configured agent; reads agent-specific `heartbeat.md`.
- **Streaming**: queue poll model (incoming/outgoing/processing), no SSE protocol.
- **Evidence**: `tinyclaw/src/queue-processor.ts`, `tinyclaw/src/lib/invoke.ts`, `tinyclaw/src/lib/agent-setup.ts`, `tinyclaw/lib/setup-wizard.sh`, `tinyclaw/lib/heartbeat-cron.sh`, `tinyclaw/docs/AGENTS.md`.

---

## 7) Cross-Repo Additions Captured

These were either missing or under-specified before and are now part of the normalized comparison:

- `bot`: offset-based stream replay model (`date:session:line`) and bootstrap injection as synthetic tool-call entries.
- `LocalAGI`: standalone periodic self-monologue loop and scheduler-backed reminders.
- `khoj`: mixed execution strategy (streaming tools sequential, others parallel via `asyncio.gather`).
- `letta-code`: approval conflict taxonomy + recovery path and optional stream resume using `run_id/seq_id`.
- `nanobot`: explicit two-layer memory design (`MEMORY.md` + append-only `HISTORY.md`) and heartbeat-empty short-circuit logic.
- `nullclaw`: multi-strategy compaction (split summarization + forced compression) and pluggable memory vtable backends.
- `openclaw`: post-compaction read audits and heartbeat delivery target/session resolution model.
- `tinyclaw`: queue-native team collaboration via internal `[@agent: ...]` enqueue flow.

---

## 8) Resolved Validation Flags

All four previously flagged validation gaps were closed with direct runtime codepath traces:

- `nullclaw` (closed): both paths exist in this repo. `HeartbeatEngine` (`nullclaw/src/heartbeat.zig`) parses `HEARTBEAT.md`, while daemon `heartbeatThread` (`nullclaw/src/daemon.zig`) performs only daemon state flush + health tick. Autonomous delivery wiring in daemon is via scheduler/bus (`nullclaw/src/cron.zig`), not `HeartbeatEngine` execution.
- `letta-code` (closed): boundary is explicit. CLI handles retry/recovery/approval orchestration (`letta-code/src/headless.ts`, `letta-code/src/cli/helpers/stream.ts`), while compaction lifecycle is server-originated and streamed back (`include_compaction_messages` in `letta-code/src/agent/message.ts`; `event_message` / `summary_message` handling in `letta-code/src/cli/helpers/accumulator.ts`).
- `openclaw` (closed): direct runtime MCP server usage is currently not active in ACP bridge flow. ACP initialization declares `mcpCapabilities.http=false` and `mcpCapabilities.sse=false`, and both `newSession` and `loadSession` explicitly ignore provided `mcpServers` (`openclaw/src/acp/translator.ts`).
- `tinyclaw` (closed): OpenCode session behavior is `opencode run --format json` plus `-c` when not resetting (`tinyclaw/src/lib/invoke.ts`). Restart/failure handling is queue-level: orphaned `processing/` files are recovered on startup and failed messages are moved back for retry (`tinyclaw/src/queue-processor.ts`).

---

## 9) Architecture Domain — Agent Loop Semantics

This section compares loop behavior using one normalized schema across all repos.

### 9.1 Loop State Machine (Normalized Across All Repos)

| Repo         | Entry / setup                                         | Main loop boundary                               | Tool phase transition                                                                                  | Terminal transition                                                               | Interrupt / cancel path                                                                        |
| ------------ | ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bot`        | Build chat stream + push `agent_start` / `turn_start` | `while (true)` around stream drains              | `TOOL_CALL_END` emits `tool_execution_end`, closes turn as `tool_calls`, then starts next turn         | `RUN_FINISHED` sets finish reason/usage; exits when no follow-ups                 | `abortController` gates strategy + loop; steering messages can halt loop                       |
| `LocalAGI`   | Start scheduler + timer runner + worker goroutines    | workers block on `jobQueue` in `select`          | `consumeJob` executes actions per job; no explicit in-turn tool fanout model in loop                   | returns when context cancelled (`ErrContextCanceled`)                             | `context.Done()` in worker + periodic runner; periodic path gated by `standaloneJob`           |
| `khoj`       | Build MCP clients + merge prior iteration history     | `while current_iteration < MAX_ITERATIONS`       | Collect iterations; run streaming tools sequentially, other tools via `asyncio.gather`                 | Ends when max iterations reached or tool sets terminate flag                      | `cancellation_event` and `interrupt_queue` can abort or inject new instruction                 |
| `letta-code` | pre-stream conflict classifier before draining stream | outer run loop around stream + stop reasons      | `requires_approval` branch batches approval decisions, executes, then re-enters loop                   | `end_turn` exits; non-retriable reasons fall through to error handling            | cancellation is explicit stop reason; approval-pending conflicts can auto-resolve and continue |
| `nanobot`    | Session/context build from bus message                | `while iteration < self.max_iterations`          | If tool calls exist: append assistant tool-call msg, execute each tool, append tool results, continue  | First non-tool assistant content breaks loop as final response                    | outer bus loop uses timeout polling; command `/new` resets session + async consolidation       |
| `nullclaw`   | Enrich with memory + append user history              | `while (iteration < self.max_tool_iterations)`   | Structured `tool_calls` parsed first, XML fallback second; executes parsed tool calls and reflects     | If no parsed calls: append assistant response, compact/trim, return final         | context-exhaustion path can force-compress history then retry                                  |
| `openclaw`   | run wrapper prepares followup run + fallback chain    | run cycle in `runAgentTurnWithFallback`          | Tool/result streaming handled via PI stream events and block pipeline; followups can be enqueued       | success path returns run result; multiple failures return final user-safe message | error classifiers can reset session (compaction, role ordering, corruption) then return/reset  |
| `tinyclaw`   | queue scan + routing to target agent/team             | polling loop every 1s + per-agent promise chains | tool/runtime delegated to provider CLI invocation (`codex`, Claude Code `claude`, OpenCode `opencode`) | message completes when response written to outgoing queue                         | per-message errors caught and converted to fallback reply; processor continues                 |

### 9.2 Retry and Error Taxonomy (Normalized)

| Repo         | Auth/session refresh retry                                          | Transient API retry                                         | Approval conflict recovery                                                             | Context overflow recovery                                                 | Session corruption/order recovery                            | Tool failure handling                                                                               |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `bot`        | ✅ auth errors refresh adapter and retry stream                     | ⚠️ auth-specific retry only in inspected loop               | ❌                                                                                     | ❌ (handled elsewhere if any)                                             | ❌                                                           | ⚠️ bubbles loop/runtime errors                                                                      |
| `LocalAGI`   | ❌                                                                  | ❌ explicit backoff not found in loop runner                | ❌                                                                                     | ❌                                                                        | ❌                                                           | ⚠️ job/action failures handled in action pipeline; loop keeps running                               |
| `khoj`       | ❌                                                                  | ⚠️ not explicit backoff, but gather exceptions are captured | ❌                                                                                     | ❌ explicit overflow recovery not found in this file                      | ❌                                                           | ✅ per-tool exceptions converted into warnings and loop continues                                   |
| `letta-code` | ⚠️ conflict classes include busy/pending approval, not auth refresh | ✅ exponential backoff up to `LLM_API_ERROR_MAX_RETRIES`    | ✅ pending-approval + invalid-tool-call-id recovery paths                              | ⚠️ classifies overflow stop reasons; hard recovery partly backend-coupled | ⚠️ role/order-related non-retriable paths explicitly handled | ✅ marks incomplete tools cancelled on stream errors                                                |
| `nanobot`    | ❌                                                                  | ❌ explicit retry not found in loop                         | ❌                                                                                     | ❌                                                                        | ❌                                                           | ✅ catches processing exceptions and emits fallback outbound error text                             |
| `nullclaw`   | ❌                                                                  | ✅ one retry on provider chat failure                       | ❌                                                                                     | ✅ force-compress history and retry once on context exhaustion            | ❌                                                           | ⚠️ tool results are recorded and fed back; hard tool failure semantics still need deeper validation |
| `openclaw`   | ✅ fallback runner can switch model/provider in-run                 | ✅ transient HTTP retry + retry cycle around fallback chain | ⚠️ no approval state machine in these files, but command pipeline handles control flow | ✅ compaction/context overflow can trigger session reset + user guidance  | ✅ role-ordering and corruption reset paths                  | ✅ errors mapped to user-safe fallback outputs while preserving loop continuity                     |
| `tinyclaw`   | ❌                                                                  | ❌ built-in backoff not found                               | ❌                                                                                     | ❌                                                                        | ❌                                                           | ✅ invocation/processing errors are caught and transformed into queue replies                       |

### 9.3 Concurrency Model (Per-Turn, Per-Session, Global)

| Repo         | Per-turn tool concurrency                                                    | Per-session serialization                                             | Global worker/scheduler concurrency                                       | Deferred/followup queue behavior                                    |
| ------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `bot`        | ⚠️ not explicit parallel fanout in inspected turn loop                       | ✅ single run stream with sequential turn boundaries                  | ⚠️ orchestrator-level parallelism outside this loop                       | ✅ follow-up messages can append and trigger next turn              |
| `LocalAGI`   | ⚠️ per-job actions, not explicit per-turn parallel tools                     | ⚠️ queue consumption may interleave jobs                              | ✅ `parallelJobs` worker pool + periodic runner + scheduler               | ✅ autonomous periodic job injection                                |
| `khoj`       | ✅ mixed mode: sequential streaming tools + parallel batch tools             | ✅ iteration order maintained even with parallel batch                | ⚠️ async task fanout inside request scope                                 | ⚠️ interruption queue can mutate next-iteration plan                |
| `letta-code` | ⚠️ stream processing + approval batches; tool fanout model backend-dependent | ✅ conversation/run loop serialized per invocation                    | ⚠️ retries and resume loops are in-process                                | ✅ recurring loop continues across stop reasons and approval phases |
| `nanobot`    | ❌ tool calls executed sequentially in loop                                  | ✅ per-session history update path is linear                          | ⚠️ bus consumer loop with async tasks for consolidation                   | ✅ `/new` and memory consolidation run asynchronously               |
| `nullclaw`   | ❌ executes parsed tool calls sequentially                                   | ✅ single history timeline per turn                                   | ⚠️ optional streaming callback path; no worker pool in this loop          | ❌ no separate followup queue layer found                           |
| `openclaw`   | ⚠️ streaming events + tool callbacks; execution model partly delegated       | ✅ active session entry keyed and mutated atomically                  | ✅ followup queue + model fallback orchestration + post-compaction audits | ✅ explicit `enqueueFollowupRun` path                               |
| `tinyclaw`   | ⚠️ delegated to provider CLI runtime (`codex`, `claude`, `opencode`)         | ✅ per-agent promise chain guarantees sequential processing per agent | ✅ cross-agent parallelism + 1s polling loop                              | ✅ internal team mentions enqueue new queue work                    |

### 9.4 Key Loop Features Captured

- `bot`: steering-aware stop condition and post-turn follow-up queue integration in the same loop.
- `LocalAGI`: periodic autonomous self-job path (`standaloneJob`) running alongside queue workers.
- `khoj`: strict mixed tool execution policy (streaming tools serialized, others parallelized).
- `letta-code`: explicit pre-stream conflict taxonomy (`resolve_approval_pending`, `retry_conversation_busy`, `retry_transient`) plus invalid tool-call ID recovery.
- `nanobot`: dual-loop architecture (agent iteration loop inside bus-processing loop) with async memory consolidation triggers.
- `nullclaw`: three-stage recovery stack (retry once, then force context compression, then fail).
- `openclaw`: session reset primitives tied to specific failure classes (compaction, role ordering, corruption) and model fallback wrapper.
- `tinyclaw`: deterministic per-agent sequencing via promise chains while preserving global parallel throughput.

---

## 10) Architecture Domain — Memory Architecture

This section applies one normalized schema to memory behavior across all repos:

- **Backend**: where memory is stored and indexed.
- **Retrieval timing**: when recall happens relative to answer generation.
- **Write triggers**: what events create/update memory.
- **Retention/compaction**: lifecycle controls (archive/summarize/prune).
- **Wiring quality**: whether memory features are fully connected in runtime path.

### 10.1 Matrix D — Memory Backend + Retrieval Timing

| Repo         | Memory backend(s)                                                                                      | Retrieval timing                                                                                                 | Retrieval injection surface                                                                                                    | Wiring quality                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bot`        | External memory service (`recall`/`retain`/`reflect`/`summarize`) + workspace memory file indexing     | Pre-answer recall during system prompt build when user message exists                                            | Recalled memory block + memory protocol instructions in system prompt; workspace daily logs loaded from `memory/YYYY-MM-DD.md` | ✅ Fully wired; graceful degradation when service unavailable                                          |
| `LocalAGI`   | RAG DB (search/store), optional long-term and summary modes                                            | Pre-answer lookup from latest user message                                                                       | Injects KB hits as top `system` message (`Given the user input you have...`)                                                   | ✅ Wired when `enableKB`, `kbAutoSearch`, and `ragdb` are set                                          |
| `khoj`       | DB `UserMemory` + vector search (recent + long-term merge)                                             | Per-turn before response generation                                                                              | Retrieved memories appended as memory context user message                                                                     | ✅ Wired behind per-user memory-enabled flag                                                           |
| `letta-code` | Letta memory blocks + memory tools (`memory_apply_patch` fallback to `memory`) + optional git memfs    | Primarily on-demand/tool-driven; reminders nudge periodic reflection                                             | System prompt reconciled to memory mode (`standard` vs `memfs`) and reminder prompts                                           | ✅ Wired with strong mode-management; recall is less auto-injected than `bot`/`khoj`                   |
| `nanobot`    | File memory: `memory/MEMORY.md` + `memory/HISTORY.md`                                                  | Every turn via system prompt construction                                                                        | `# Memory` section added by context builder                                                                                    | ✅ Wired; simple file-based retrieval model                                                            |
| `nullclaw`   | Memory vtable (`sqlite`, `markdown`, `lucid`, `none`) + category model (`core`/`daily`/`conversation`) | Every turn via memory-enriched user message                                                                      | `memory_loader.enrichMessage` prepends `[Memory context]` before user message                                                  | ⚠️ Core enrichment/autosave is wired, but exposed memory tools are not backend-bound in inspected path |
| `openclaw`   | Workspace markdown memory files + hybrid memory index manager (embeddings/vector/FTS)                  | On-demand via memory tools; index warm/sync on session/search                                                    | `memory_search` and `memory_get` tools + memory-aware system prompt section                                                    | ✅ Wired with configurable search backend/fallback and citation policy                                 |
| `tinyclaw`   | No native structured memory subsystem; relies on provider conversation state + workspace docs          | Delegated to provider CLI session continuation (`codex`, `claude`, `opencode`; flags like `-c`, `resume --last`) | AGENTS/SOUL/heartbeat docs in per-agent workspace                                                                              | ⚠️ Works pragmatically, but no first-class memory abstraction                                          |

### 10.2 Matrix E — Write Triggers + Retention/Compaction

| Repo         | Write triggers                                                                    | Write granularity                                                        | Retention / compaction                                                                              | Highest-value risk                                                                                 |
| ------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `bot`        | Turn-end retain (async), session reflect/summarize, pre-compaction memory flush   | Fact extraction + conversation summaries + workspace memory file updates | Memory flush gate at high token usage + cooldown; workspace re-index after flush                    | Memory service outage downgrades memory quality without hard failure                               |
| `LocalAGI`   | Conversation save path; summary mode; `add_memory` action                         | User-only / user+assistant / whole-conversation modes                    | Scheduled compaction groups entries by period, can summarize, stores `summary-*`, deletes originals | Behavior depends heavily on config switches; easy to misconfigure                                  |
| `khoj`       | `save_to_conversation_log` then `ai_update_memories`                              | LLM-extracted fact create/delete operations                              | No explicit compaction layer found in inspected scope                                               | Memory update quality depends on extraction prompt correctness                                     |
| `letta-code` | Memory tool writes + memfs workflows + reflection reminders                       | Block-level updates and optional git-backed memory filesystem operations | Mode drift detection; memfs git history and sync flows                                              | Mixed mode complexity (standard vs memfs) can drift without guardrails                             |
| `nanobot`    | Auto consolidation when message window exceeded; `/new` archives all              | Writes `history_entry` summary + `memory_update` full long-term content  | `last_consolidated` cursor prevents reprocessing; keeps recent half-window in session               | Consolidation is async; failures can silently delay memory updates                                 |
| `nullclaw`   | Auto-save user + assistant snippets; memory API calls                             | Conversation/daily/core categories in backend                            | Hygiene subsystem archives old files, purges archives, prunes old conversation rows                 | `memory_store`/`memory_recall` tools default to “backend not configured” despite backend existence |
| `openclaw`   | Pre-compaction memory flush runner when threshold crossed                         | Durable notes intended for `memory/YYYY-MM-DD.md` append flow            | Per-compaction flush metadata; memory index sync/watch/interval refresh                             | Flush is skipped for non-writable sandbox, heartbeats, and CLI providers                           |
| `tinyclaw`   | Provider-level conversation continuation + file edits; periodic heartbeat prompts | Provider transcript state + queue/chat artifacts                         | Queue/log retention and provider session lifecycle; no dedicated memory compactor                   | No structured retention policy for long-term memory quality                                        |

### 10.3 Key Memory Features Captured

- `bot`: two-path memory model (external semantic memory + local daily memory files) and explicit pre-compaction flush gate.
- `LocalAGI`: configurable storage modes (`user_only`, `user_and_assistant`, `whole_conversation`) plus scheduled KB compaction to `summary-*`.
- `khoj`: dual retrieval merge (recent + semantic long-term) with de-dup before prompt injection; memory manager prompt does create/delete diffs.
- `letta-code`: hard split between standard memory blocks and git memfs mode, with prompt drift detection and memfs-aware reminders.
- `nanobot`: LLM-based consolidation contract with strict JSON output (`history_entry`, `memory_update`) and `last_consolidated` cursor.
- `nullclaw`: rich backend abstraction + hygiene lifecycle, but runtime tool wiring gap for memory tools.
- `openclaw`: memory flush turn is an explicit sub-run with threshold logic, sandbox checks, and compaction-count dedupe.
- `tinyclaw`: memory behavior is intentionally delegated to provider session mechanics; local files act as bootstrap memory, not indexed memory.

### 10.4 Evidence Anchors — Memory

- `bot/apps/server/src/ai/system-prompt.ts`, `bot/apps/server/src/ai/workspace.ts`, `bot/packages/agent/src/orchestrator.ts`
- `LocalAGI/core/agent/knowledgebase.go`, `LocalAGI/core/state/compaction.go`
- `khoj/src/khoj/routers/api_chat.py`, `khoj/src/khoj/processor/conversation/utils.py`, `khoj/src/khoj/routers/helpers.py`, `khoj/src/khoj/processor/conversation/prompts.py`
- `letta-code/src/agent/create.ts`, `letta-code/src/agent/memoryPrompt.ts`, `letta-code/src/agent/memoryFilesystem.ts`, `letta-code/src/cli/helpers/memoryReminder.ts`
- `nanobot/nanobot/agent/context.py`, `nanobot/nanobot/agent/memory.py`, `nanobot/nanobot/agent/loop.py`, `nanobot/nanobot/session/manager.py`
- `nullclaw/src/memory/root.zig`, `nullclaw/src/agent/memory_loader.zig`, `nullclaw/src/agent/root.zig`, `nullclaw/src/tools/root.zig`, `nullclaw/src/tools/memory_store.zig`, `nullclaw/src/tools/memory_recall.zig`, `nullclaw/src/memory/hygiene.zig`
- `openclaw/src/agents/tools/memory-tool.ts`, `openclaw/src/auto-reply/reply/agent-runner-memory.ts`, `openclaw/src/auto-reply/reply/memory-flush.ts`, `openclaw/src/memory/manager.ts`, `openclaw/src/memory/internal.ts`, `openclaw/src/agents/workspace.ts`
- `tinyclaw/src/lib/agent-setup.ts`, `tinyclaw/src/lib/invoke.ts`, `tinyclaw/src/queue-processor.ts`, `tinyclaw/lib/heartbeat-cron.sh`

---

## 11) Architecture Domain — Session Lifecycle and Compaction

This section normalizes session lifecycle behavior across all repos and separates:

- **Session controls** (create/resume/reset/fork/evict/archive)
- **Compaction controls** (trigger, transformation, safety fallback)

### 11.1 Matrix F — Session Lifecycle Controls and Artifacts

| Repo         | Create + resume path                                                                                         | Reset/new semantics                                                                                            | Branch/fork model                                                           | Eviction/archive model                                                                 | Persistent artifacts                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `bot`        | Feed sessions are listed/resumed via `/feeds/:feedId/sessions` and `/resume`; branch switching via `/branch` | New active branch/session selection is explicit API-driven                                                     | ✅ Tree model with branch switch + fork to new session (`forkToNewSession`) | ⚠️ No explicit idle eviction path in inspected session route/orchestrator files        | Feed logs + session metadata DB rows                                  |
| `LocalAGI`   | Per-key `ConversationTracker` returns current history until TTL expiry                                       | Expiry behaves like implicit reset; explicit `/new` style command not found in inspected core loop             | ❌                                                                          | ✅ Old conversations auto-cleaned by duration window                                   | In-memory tracker + optional conversation JSON saves                  |
| `khoj`       | `aget_conversation_by_user` resumes by id/title/latest or creates if missing                                 | `create_new=True` forces new conversation row                                                                  | ❌                                                                          | ⚠️ No explicit conversation eviction/rotation in inspected adapters                    | DB `Conversation` rows with JSON conversation log                     |
| `letta-code` | CLI supports `--continue`, `--conversation`, and default new conversation behavior                           | `--new` creates new conversation; default headless path also creates new conversation to avoid busy collisions | ❌ (multi-conversation, no tree branch API found)                           | ⚠️ Retention delegated to backend/service; local LRU settings hold “last session” refs | Remote conversation objects + local `.letta` last-session settings    |
| `nanobot`    | `SessionManager.get_or_create` loads/creates JSONL session per key                                           | `/new` clears session, invalidates cache, starts async archive/consolidation                                   | ❌                                                                          | ⚠️ No built-in TTL eviction in session manager                                         | `workspace/sessions/*.jsonl` (metadata + append-only messages)        |
| `nullclaw`   | `SessionManager.getOrCreate` creates session keyed runtime object                                            | `/new` clears agent history for the active session                                                             | ❌                                                                          | ✅ `evictIdle(max_idle_secs)` removes stale sessions                                   | In-process session map (non-durable across restart)                   |
| `openclaw`   | Session key resolves store entry + freshness policy; resumes when fresh                                      | Reset triggers + policy (`daily`/`idle`) allocate new `sessionId`, preserve selected user overrides            | ⚠️ Parent-session fork path creates branched session files                  | ✅ Store maintenance (prune/cap/rotate) + transcript archiving on reset                | `sessions.json` store + per-session JSONL transcript files + archives |
| `tinyclaw`   | Provider conversation resume delegated to CLI (`claude -c`, `codex exec resume --last`, `opencode -c`)       | Per-agent `reset_flag` disables resume flags for next invocation                                               | ❌                                                                          | ⚠️ Queue cleanup/manual ops; no first-class session eviction policy in runtime         | Queue files + provider-managed session state in agent working dirs    |

### 11.2 Matrix G — Compaction and Context Pressure Behavior

| Repo         | Trigger                                                                                       | Compaction strategy                                                                                      | Failure / overflow recovery                                              | Observability signal                                         |
| ------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `bot`        | Context estimate threshold (memory flush gate) + context builder compaction                   | Pre-compaction memory flush + token-aware context trimming                                               | Orchestrator recovers interrupted turns and orphaned tool calls          | Emits memory-flush and compaction ephemeral events           |
| `LocalAGI`   | KB compaction ticker (`daily`/`weekly`/`monthly`) when enabled                                | Groups KB entries by period, optional summarization, writes `summary-*`, deletes originals               | Warns/logs compaction failures, continues runtime                        | Compaction logs only                                         |
| `khoj`       | Iterative planner bounded by max iterations and token-limited message assembly                | Primarily truncation/budgeting rather than transcript summarization in inspected path                    | Tool exceptions captured per-iteration; loop continues                   | Iteration warnings and status events                         |
| `letta-code` | Reflection trigger supports `compaction-event` (memfs required)                               | Reflection/reminder layer tied to memory mode; no local transcript compactor found in inspected CLI path | Busy/pending-approval and retry policies handle many pre-stream failures | Structured stream events + retry telemetry                   |
| `nanobot`    | Session message window (`memory_window`) overflow and `/new`                                  | Consolidates old transcript into `HISTORY.md` summary + `MEMORY.md` update; retains recent window        | Consolidation is async/best-effort; runtime continues on failure         | Consolidation logs with `last_consolidated` cursor           |
| `nullclaw`   | Message-count or token-estimate triggers in `autoCompactHistory`; context-exhaustion fallback | Summarizes older slice(s), keeps recent messages, preserves system prompt                                | One-shot `forceCompressHistory` on context exhaustion before failing     | Tracks `last_turn_compacted` and session `last_consolidated` |
| `openclaw`   | Auto/manual compaction + memory flush thresholds                                              | Compaction plus post-compaction context injection and read-audit layer                                   | Resets session on compaction failure / role-ordering conflict            | Run logs + compaction count + audit warnings                 |
| `tinyclaw`   | No native compactor in queue runtime                                                          | Delegated to provider CLI conversation management                                                        | Per-message invocation errors converted to queue responses               | Queue logs only                                              |

### 11.3 Key Session/Compaction Features Captured

- `bot`: branch switch can optionally summarize abandoned branch path before leaf switch.
- `openclaw`: reset policy is channel/type aware and supports parent-session forking plus transcript archival.
- `tinyclaw`: reset semantics are per-agent and file-flag based (`reset_flag`) rather than global.
- `nullclaw`: clear separation between proactive auto-compaction and emergency force-compression.
- `nanobot`: `/new` archives full prior session asynchronously while immediately returning a fresh session.

### 11.4 Evidence Anchors — Session and Compaction

- `bot/apps/server/src/routes/sessions.ts`, `bot/packages/agent/src/orchestrator.ts`
- `LocalAGI/core/conversations/conversationstracker.go`, `LocalAGI/core/agent/knowledgebase.go`, `LocalAGI/core/state/compaction.go`
- `khoj/src/khoj/database/adapters/__init__.py`
- `letta-code/src/headless.ts`, `letta-code/src/settings-manager.ts`
- `nanobot/nanobot/session/manager.py`, `nanobot/nanobot/agent/loop.py`
- `nullclaw/src/session.zig`, `nullclaw/src/agent/root.zig`
- `openclaw/src/auto-reply/reply/session.ts`, `openclaw/src/auto-reply/reply/agent-runner.ts`, `openclaw/src/config/sessions/reset.ts`, `openclaw/src/config/sessions/store.ts`, `openclaw/src/config/sessions/transcript.ts`
- `tinyclaw/src/queue-processor.ts`, `tinyclaw/src/lib/invoke.ts`, `tinyclaw/src/lib/routing.ts`, `tinyclaw/lib/agents.sh`

---

## 12) Architecture Domain — Bootstrap, Identity, and Onboarding

This section compares first-run behavior, identity source-of-truth, and setup ergonomics.

### 12.1 Matrix H — Bootstrap and First-Turn Behavior

| Repo         | Bootstrap seed mechanism                                                                                                        | First-turn behavior                                                                              | Identity source at runtime                                             | Onboarding mode                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `bot`        | `ensureAgentWorkspace` seeds template files (`AGENTS`, `SOUL`, `IDENTITY`, `USER`, `TOOLS`, `HEARTBEAT`, `BOOTSTRAP`, `MEMORY`) | First turn injects synthetic `workspace_read BOOTSTRAP.md` tool-call/result into durable history | Workspace files + system prompt builder + recalled memory              | Config-driven plus conversational bootstrap file ritual |
| `LocalAGI`   | No workspace template scaffolding found in inspected core runtime                                                               | No first-turn bootstrap injection path found                                                     | Character struct loaded/generated and persisted via character file     | Config/options centric                                  |
| `khoj`       | DB-centric agent creation (`create_default_agent`) with personality template                                                    | Standard conversation flow; no workspace bootstrap file ritual                                   | Agent DB fields (`personality`, model, tools)                          | Product onboarding in app/UI, not file bootstrap        |
| `letta-code` | Agent creation + system prompt preset + memory mode wiring                                                                      | Conversation selection/new creation happens before loop; no BOOTSTRAP file injection path found  | Prompt preset + memory blocks + agent config                           | Rich CLI flags and selectors                            |
| `nanobot`    | Workspace template docs (`AGENTS`, `SOUL`, `USER`, `TOOLS`, `HEARTBEAT`)                                                        | Context builder loads bootstrap files into system prompt each turn                               | Workspace docs + memory files via context builder                      | Template-first with config startup                      |
| `nullclaw`   | `scaffoldWorkspace` writes full bootstrap set + memory dir                                                                      | Prompt builder injects workspace identity files every run                                        | Workspace identity docs (+ optional AIEOS identity path)               | `onboard` wizard and quick setup paths                  |
| `openclaw`   | Workspace template loader + write-if-missing seeding and onboarding state file                                                  | Bootstrap/context files resolved before prompt build; onboarding completion tracked in state     | Workspace docs + runtime prompt composition with tool/runtime sections | `openclaw onboard` plus profile-aware workspace setup   |
| `tinyclaw`   | Setup wizard + `ensureAgentDirectory` copy/symlink flow (`.claude`, `heartbeat.md`, `AGENTS.md`, `SOUL.md`, skills links)       | New agent dirs are initialized lazily on first invoke; no explicit first-turn bootstrap event    | Agent config (`system_prompt`/`prompt_file`) + workspace docs          | Bash wizard + per-agent setup scripts                   |

### 12.2 Matrix I — Identity Mutability and Onboarding Friction

| Repo         | Runtime-editable identity surface                            | Hard-coded / config-bound identity parts                                            | Setup friction snapshot                                               |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `bot`        | High: markdown identity files directly editable in workspace | Provider/model wiring in agent config                                               | Medium: simple bootstrap model, but relies on file discipline         |
| `LocalAGI`   | Medium: character file and state are editable artifacts      | Many behavioral controls in config options                                          | Medium: requires config literacy, less guided bootstrap               |
| `khoj`       | High: agent personality and metadata in DB                   | Platform defaults and model config gates                                            | Low-Medium: productized onboarding, less file complexity              |
| `letta-code` | High: prompt presets, memory blocks, mode switches           | Backend conversation semantics and service-side constraints                         | Medium: powerful but many flags/modes                                 |
| `nanobot`    | High: workspace markdown identity + memory docs              | Provider/runtime options in startup config                                          | Low-Medium: straightforward template model                            |
| `nullclaw`   | High: scaffolded identity files + AIEOS support              | Provider/config JSON parameters                                                     | Medium: wizard helps, but many runtime knobs                          |
| `openclaw`   | High: workspace templates and context files are first-class  | Config controls for routing/sandbox/heartbeat/skills                                | Medium-High: very capable, broad config surface                       |
| `tinyclaw`   | Medium-High: per-agent prompt fields and docs editable       | Behavior strongly delegated to chosen provider CLIs (`codex`, `claude`, `opencode`) | Low-Medium: simple wizard, but behavior split across bash+TS+provider |

### 12.3 Key Bootstrap/Identity Features Captured

- `bot`: BOOTSTRAP is not just a file; it is injected as tool history so it becomes part of session state.
- `openclaw`: onboarding state is explicit and versioned (`workspace-state.json`) rather than implicit file presence.
- `tinyclaw`: per-agent workspace creation includes skill symlink propagation for immediate capability parity.
- `nullclaw`: prompt builder consumes `HEARTBEAT.md` and `BOOTSTRAP.md` as identity-context files, not just auxiliary docs.

### 12.4 Evidence Anchors — Bootstrap and Identity

- `bot/apps/server/src/ai/workspace.ts`, `bot/packages/agent/src/orchestrator.ts`, `bot/apps/server/src/templates/*.md`
- `LocalAGI/core/agent/identity.go`, `LocalAGI/core/agent/state.go`, `LocalAGI/core/agent/templates.go`
- `khoj/src/khoj/database/adapters/__init__.py`, `khoj/src/khoj/processor/conversation/prompts.py`
- `letta-code/src/headless.ts`, `letta-code/src/agent/promptAssets.ts`, `letta-code/src/agent/prompts/`
- `nanobot/nanobot/agent/context.py`, `nanobot/workspace/*.md`
- `nullclaw/src/onboard.zig`, `nullclaw/src/agent/prompt.zig`, `nullclaw/src/identity.zig`
- `openclaw/src/agents/workspace.ts`, `openclaw/src/agents/system-prompt.ts`, `openclaw/docs/reference/templates/*.md`
- `tinyclaw/lib/setup-wizard.sh`, `tinyclaw/src/lib/agent-setup.ts`, `tinyclaw/AGENTS.md`, `tinyclaw/heartbeat.md`

---

## 13) Architecture Domain — Heartbeat and Autonomy Safety

This section compares proactive/autonomous loops with emphasis on **safety gates** and **no-op suppression**.

### 13.1 Matrix J — Heartbeat Runtime Model

| Repo         | Runtime trigger                                                                                                     | Prompt/task source                                                                       | Ack semantics                                                       | Delivery target/routing                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `bot`        | Scheduler loop in heartbeat runner                                                                                  | `HEARTBEAT.md` (feed → agent workspace → global fallback) + constructed heartbeat prompt | ✅ strips/suppresses `HEARTBEAT_OK` and short ack                   | Feed publish path, dedup-aware                                                                                     |
| `LocalAGI`   | Periodic timer + standalone self-job                                                                                | `innerMonologueTemplate` (not heartbeat file based)                                      | ❌ token-ack model not used                                         | Internal job execution path                                                                                        |
| `khoj`       | Not found in inspected runtime                                                                                      | N/A                                                                                      | ❌                                                                  | N/A                                                                                                                |
| `letta-code` | Not found as first-class heartbeat in inspected CLI runtime                                                         | N/A                                                                                      | ❌                                                                  | N/A                                                                                                                |
| `nanobot`    | `HeartbeatService` interval loop                                                                                    | `HEARTBEAT.md` when actionable; default heartbeat prompt                                 | ✅ token check for `HEARTBEAT_OK`                                   | On-heartbeat callback into normal agent loop                                                                       |
| `nullclaw`   | Both paths are in-repo: `HeartbeatEngine` parses `HEARTBEAT.md`; daemon heartbeat thread is state/health flush only | `HEARTBEAT.md` task bullets (module-level)                                               | ❌ in daemon heartbeat path                                         | ⚠️ Task delivery uses scheduler/bus path; no bridge from daemon heartbeat thread to `HeartbeatEngine.tick()` found |
| `openclaw`   | Dedicated heartbeat runner + scheduler integrations                                                                 | Configured heartbeat prompt, with exec/cron-specific prompt overrides                    | ✅ robust strip/suppress semantics                                  | Session-aware target resolution (`last`, explicit account/channel/thread)                                          |
| `tinyclaw`   | Shell cron loop (`heartbeat-cron.sh`)                                                                               | Agent-specific `heartbeat.md` or default prompt string                                   | ❌ no explicit ack token stripping/suppression in inspected scripts | Enqueues heartbeat messages via queue to per-agent routing                                                         |

### 13.2 Matrix K — Safety Gates for Proactive Behavior

| Repo         | Active-hours guard                                           | In-flight guard                                  | Empty heartbeat skip                                               | Duplicate suppression                                 | Additional safety notes                                                                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bot`        | ✅ quiet-hours check                                         | ⚠️ no explicit queue-size gate in inspected file | ✅ empty file/content skip                                         | ✅ dedup window in feed state                         | Minimal mode prompt build for heartbeat run                                                             |
| `LocalAGI`   | ❌                                                           | ❌                                               | ❌ (not file-based)                                                | ❌                                                    | Safety depends on generic job/action controls                                                           |
| `khoj`       | ❌                                                           | ❌                                               | ❌                                                                 | ❌                                                    | No heartbeat subsystem in inspected scope                                                               |
| `letta-code` | ❌                                                           | ❌                                               | ❌                                                                 | ❌                                                    | No dedicated heartbeat path in inspected scope                                                          |
| `nanobot`    | ❌                                                           | ❌                                               | ✅ `_is_heartbeat_empty` gate                                      | ❌                                                    | Simple, low-overhead implementation                                                                     |
| `nullclaw`   | ⚠️ daemon heartbeat is health/state-oriented (not task-exec) | ⚠️                                               | ⚠️                                                                 | ⚠️                                                    | Scheduler/bus path is wired; heartbeat-task safety gates are not first-class in daemon heartbeat thread |
| `openclaw`   | ✅ active-hours policy                                       | ✅ skips when requests in flight                 | ✅ effective-empty heartbeat skip with exceptions (exec/cron/wake) | ✅ duplicate heartbeat suppression + transcript prune | Also preserves last-updated timestamps on suppressed runs                                               |
| `tinyclaw`   | ❌ (interval-only loop)                                      | ❌                                               | ❌ explicit file-emptiness gate not found in script                | ❌                                                    | Operationally simple but can nag without external controls                                              |

### 13.3 Key Heartbeat/Autonomy Features Captured

- `openclaw`: heartbeat path is event-aware (exec/cron/wake) and can switch prompt semantics per event type.
- `bot`: heartbeat combines token strip, dedup, and active-hours gating in one deterministic run path.
- `nanobot`: lightweight heartbeat intentionally short-circuits when no actionable file content exists.
- `nullclaw`: heartbeat capability exists as reusable engine, but daemon heartbeat currently signals runtime health only; it does not run `HEARTBEAT.md` task execution directly.

### 13.4 Evidence Anchors — Heartbeat and Autonomy

- `bot/apps/server/src/ai/heartbeat.ts`, `bot/apps/server/src/ai/heartbeat-runner.ts`
- `LocalAGI/core/agent/agent.go`, `LocalAGI/core/agent/templates.go`
- `nanobot/nanobot/heartbeat/service.py`
- `nullclaw/src/heartbeat.zig`, `nullclaw/src/daemon.zig`
- `openclaw/src/auto-reply/heartbeat.ts`, `openclaw/src/infra/heartbeat-runner.ts`
- `tinyclaw/lib/heartbeat-cron.sh`, `tinyclaw/src/queue-processor.ts`

---

## 14) Architecture Domain — Prompt Surface and Word-for-Word Diff Corpus

This section establishes a reproducible corpus and comparison method for automated word-for-word prompt diffs.

### 14.1 Corpus Manifest (Current Snapshot)

| Repo         | Prompt corpus roots                                                                                                                         | Notes for diff fidelity                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bot`        | `bot/apps/server/src/ai/system-prompt.ts`, `bot/apps/server/src/templates/*.md`                                                             | Includes both code-generated prompt sections and file templates                                                       |
| `LocalAGI`   | `LocalAGI/core/agent/templates.go`, `LocalAGI/core/agent/prompt.go`                                                                         | Prompt strings are code constants and template fragments                                                              |
| `khoj`       | `khoj/src/khoj/processor/conversation/prompts.py`                                                                                           | Centralized prompt templates in Python module                                                                         |
| `letta-code` | `letta-code/src/agent/promptAssets.ts`, `letta-code/src/agent/prompts/*`                                                                    | Many variant prompts (default + provider-specific + memory add-ons)                                                   |
| `nanobot`    | `nanobot/nanobot/agent/context.py`, `nanobot/workspace/*.md`                                                                                | Hybrid: generated identity prompt + workspace markdown                                                                |
| `nullclaw`   | `nullclaw/src/agent/prompt.zig`, `nullclaw/src/onboard.zig`, `nullclaw/src/identity.zig`                                                    | Prompt built dynamically from workspace files + tool schemas                                                          |
| `openclaw`   | `openclaw/src/agents/system-prompt.ts`, `openclaw/src/auto-reply/reply/commands-system-prompt.ts`, `openclaw/docs/reference/templates/*.md` | Layered prompt composition with runtime/tool/context overlays                                                         |
| `tinyclaw`   | `tinyclaw/AGENTS.md`, `tinyclaw/heartbeat.md`, `tinyclaw/src/lib/agent-setup.ts`                                                            | Prompt mostly delegated to provider CLIs (`codex`, Claude Code `claude`, OpenCode `opencode`) + copied workspace docs |

### 14.2 Normalized Prompt Sections for Cross-Repo Diff

Use this exact section schema for extraction/diff to avoid “apples-to-oranges” comparisons:

1. `identity_framing`
2. `tool_use_policy`
3. `memory_instructions`
4. `session_instructions`
5. `heartbeat_behavior`
6. `safety_constraints`
7. `delegation_subagent_policy`
8. `formatting_output_contract`

### 14.3 Preliminary Divergence Highlights

- **Highest identity plasticity**: `bot`, `openclaw`, `nanobot`, `nullclaw` (workspace docs heavily influence live persona).
- **Strongest explicit safety text density**: `openclaw` and `nullclaw` prompt builders.
- **Most provider-delegated prompt behavior**: `tinyclaw` (agent prompt surface mostly lives in provider CLIs: `codex`, `claude`, `opencode`, plus AGENTS docs).
- **Most multi-variant prompt bundles**: `letta-code` (provider variants + memory/system add-ons).
- **Most product-personality prompt centralization**: `khoj`.

### 14.4 Evidence Anchors — Prompt Surface

- `bot/apps/server/src/ai/system-prompt.ts`, `bot/apps/server/src/templates/*.md`
- `LocalAGI/core/agent/templates.go`, `LocalAGI/core/agent/prompt.go`
- `khoj/src/khoj/processor/conversation/prompts.py`
- `letta-code/src/agent/promptAssets.ts`, `letta-code/src/agent/prompts/*`
- `nanobot/nanobot/agent/context.py`, `nanobot/workspace/*.md`
- `nullclaw/src/agent/prompt.zig`, `nullclaw/src/onboard.zig`, `nullclaw/src/identity.zig`
- `openclaw/src/agents/system-prompt.ts`, `openclaw/src/auto-reply/reply/commands-system-prompt.ts`, `openclaw/docs/reference/templates/*.md`
- `tinyclaw/AGENTS.md`, `tinyclaw/heartbeat.md`, `tinyclaw/src/lib/agent-setup.ts`
