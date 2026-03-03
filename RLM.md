# RLM-First Agent Architecture for Ellie

Date: 2026-03-03

## Goal

Turn Ellie into an RLM-first agent architecture (REPL-first, print-gated context, persistent scratchpad), using Bun v1.3.10's native REPL and reusing as much of current Ellie + ypi patterns as possible.

This document combines:

- the Knot0 article you shared,
- our reverse-engineering of `ypi`,
- a deep audit of Ellie's current agent stack,
- extra primary-source research (CodeAct, RLM, Bun, Claude docs/system card).

---

## 1) Executive Summary

### Core thesis

The architecture jump is not "add a better tool". It is "change what one turn means":

- Tool-call agent: one turn = one tool call.
- Command agent: one turn = one shell command.
- RLM agent: one turn = a program in a persistent environment.

### What this means for Ellie

Ellie already has most of the hard operational pieces:

- agent loop + eventing,
- shell/search/edit tools,
- script execution via `run_ptc_script`,
- runtime guardrail layer end-to-end,
- durable event store/session model.

What is missing is the **persistent scratchpad model**:

- persistent REPL state across turns,
- print-gated context ingestion,
- optional persistence across runs,
- recursive sub-call primitive with shared tree guardrails.

### Recommended path

1. Keep current runtime guardrail layer as-is (orthogonal).
2. Add a persistent REPL runtime service.
3. Enforce a print/commit contract (do not auto-inject raw outputs into model context).
4. Persist REPL snapshots per session/workspace.
5. Add an `rlm_query`-like sub-agent primitive (sync + async).
6. Then flip default loop from tool-call-first to REPL-first.

---

## 2) Claim Audit (Article + Research)

Status legend:

- `Verified`: confirmed from primary source.
- `Partially verified`: direction verified, exact number/text not fully recovered.
- `Article claim`: only present in shared article text; not independently verified yet.

| Claim                                                                | Status                                                | Notes / Source                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeAct beats JSON/text action formats; up to ~20% success gains     | Verified                                              | CodeAct paper intro/abstract language confirms up to 20% absolute improvement. Source: https://arxiv.org/abs/2402.01030                                                         |
| CodeAct requires up to ~30% fewer actions                            | Verified                                              | Explicitly stated in paper intro. Source: https://arxiv.org/abs/2402.01030                                                                                                      |
| CodeAct eval spans 17 LLMs                                           | Verified                                              | Explicit in intro text. Source: https://arxiv.org/abs/2402.01030                                                                                                                |
| "21.3% higher success when no parsing errors"                        | Article claim                                         | Could not find this exact figure in accessible paper text scrape; keep as unverified unless we recover exact table/appendix row.                                                |
| Claude Code has very small built-in tool surface                     | Verified (direction), outdated exact count in article | Current official docs list more than 14 tools (now includes Task tools, Agent, Skill, LSP, etc.). Source: https://code.claude.com/docs/en/settings.md#tools-available-to-claude |
| Claude Opus 4.5 reached 80.9% SWE-bench Verified                     | Verified                                              | Present in Claude Opus 4.5 system card benchmark table. Source: https://assets.anthropic.com/m/64823ba7485345a7/original/Claude-Opus-4-5-System-Card.pdf                        |
| "First model to break 80%, ahead of GPT-5.1 and Gemini 3 Pro"        | Partially verified                                    | Current system card table shows Opus 4.5 at 80.9 with GPT-5.1/Gemini 3 Pro lower in that table. "first" wording across all history not independently established here.          |
| "Devin +18% planning, +12% end-to-end after Sonnet 4.5 switch"       | Article claim                                         | Did not recover a primary source with these exact percentages in this pass.                                                                                                     |
| RLM can process up to two orders of magnitude beyond context windows | Verified                                              | RLM intro/section text confirms orders-of-magnitude scaling claims. Source: https://arxiv.org/abs/2512.24601                                                                    |
| RLM-Qwen3-8B improves by ~28.3% average over baseline                | Verified                                              | Explicit in paper results text. Source: https://arxiv.org/abs/2512.24601                                                                                                        |
| RLM keeps only small metadata about REPL stdout in history           | Verified                                              | Explicit formal description in paper (sec3 source). Source: https://arxiv.org/abs/2512.24601                                                                                    |
| Bun v1.3.10 includes new native REPL                                 | Verified                                              | Release notes and REPL docs confirm rewrite + feature set. Sources: https://bun.com/blog/bun-v1.3.10 and https://bun.com/docs/runtime/repl                                      |

---

## 3) Architecture Progression (from the article, distilled)

## Gen 1: CodeAct

- Key win: let the model emit executable code instead of rigid tool JSON.
- Why it works: code composes control + data flow naturally.
- Limitation: execution state is ephemeral between turns.

## Gen 2: Terminal-native coding agents

- Key win: full OS/shell as action space.
- Limitation: each command output still gets pushed back into transcript context, creating context bloat and long-turn fragility.

## Gen 3: RLM

- Key win: persistent REPL variables through turns.
- Critical mechanism: only summarized/selected output (metadata/print) should enter model history.
- Limitation in paper baseline: persistence is typically in-task, not guaranteed across independent runs.

## Knot0 extension (as described in article)

- Persist scratchpad state across runs (snapshot/restore variables).
- Position REPL-first as default loop, not a specialized long-context mode.

---

## 4) ypi Deep Dive: What Is Reusable

## 4.1 Core shape

`ypi` is a shell-native RLM harness with minimal moving parts:

- `ypi`: launcher that sets RLM env and system prompt.
- `rlm_query`: recursive sub-call primitive (sync + async).
- `SYSTEM_PROMPT.md`: teaches decomposition patterns.
- `rlm_parse_json`, `rlm_cost`, `rlm_sessions`, `rlm_cleanup`: operational helpers.

## 4.2 Guardrails worth copying

`rlm_query` enforces tree-wide limits with simple env propagation:

- depth cap: `RLM_DEPTH`, `RLM_MAX_DEPTH`.
- call cap: `RLM_CALL_COUNT`, `RLM_MAX_CALLS`.
- wall-clock cap: `RLM_TIMEOUT`, `RLM_START_TIME`.
- budget cap: `RLM_BUDGET`, `RLM_COST_FILE`.
- recursion disable at max depth via PATH scrubbing.

## 4.3 Session and trace patterns worth copying

- Shared trace id: `RLM_TRACE_ID`.
- Per-call session files: `RLM_SESSION_DIR/..._d<depth>_c<call>.jsonl`.
- Optional parent-session forking for inherited conversational history.
- Optional shared session visibility (`rlm_sessions`, gated by `RLM_SHARED_SESSIONS`).

## 4.4 Async subcalls pattern worth copying

- `--async` returns `{ job_id, output, sentinel, pid }`.
- Parent can continue and later collect results.
- This is useful for fan-out/fan-in subtasks.

## 4.5 Known pitfalls ypi already solved

From `ypi/AGENTS.md` bug history:

- false stdin detection in CI,
- oversized inline system-prompt shell args,
- runaway recursion behavior from over-aggressive prompts.

These are directly relevant to Ellie if we add recursive REPL calls.

---

## 5) Ellie Deep Dive: Current State vs RLM Target

## 5.1 What Ellie already has (strong foundation)

### Agent runtime and orchestration

- Stateful `Agent` class with queues, steering/follow-ups, event subscribers.
- Loop orchestration in `packages/agent/src/agent-loop.ts`.

### Tooling surface

- Shell tool (`Bun.spawn` wrapper).
- Ripgrep tool.
- Workspace read/write tools.
- `run_ptc_script` (sandboxed TypeScript execution over bridged tools).

### Runtime guardrail layer (already production-grade)

End-to-end implemented and tested:

- policy schema + types (`runtimeLimits`),
- env wiring (`AGENT_LIMIT_MAX_WALL_CLOCK_MS`, `AGENT_LIMIT_MAX_MODEL_CALLS`, `AGENT_LIMIT_MAX_COST_USD`),
- enforcement in loop,
- `limit_hit` event emission,
- persistence into event store,
- test coverage in `packages/agent/test/agent-loop.test.ts`.

### Durability

- Session/event model in DB,
- run IDs,
- event persistence for lifecycle and guardrails.

## 5.2 What Ellie does not have yet (RLM gap)

1. No persistent REPL namespace across turns.
   `run_ptc_script` executes a child process per invocation and resets state.

2. No print-gated context contract.
   Tool outputs are still returned as text payloads into conversation history (with truncation safety, but still context pollution).

3. No scratchpad snapshot/restore across runs.
   Session history persists, variable state does not.

4. No first-class recursive sub-call primitive with tree-shared budgets and trace.

5. No explicit REPL-state observability model (`repl_exec`, `repl_snapshot`, etc.).

---

## 6) Runtime Guardrails Are Orthogonal (Explicitly)

Your earlier framing is correct: **runtime guardrails are their own layer**.

They should remain orthogonal to RLM loop internals:

- keep current guardrail policy source of truth,
- keep current `limit_hit` semantics and event schema,
- only add REPL-specific limits as additional counters/observability,
- do not intertwine REPL business logic with policy parsing/wiring.

Practical rule:

- Existing run guardrails continue to cap the whole run.
- REPL-specific limits cap per-step/per-state internals.

---

## 7) Proposed RLM-First Architecture for Ellie

## 7.1 High-level target

A run should look like:

1. restore REPL state for session/workspace (if exists),
2. model writes program block(s),
3. runtime executes inside persistent REPL,
4. only explicit commit output (print/return summary) is injected into model context,
5. persist updated state snapshot,
6. emit structured events for traceability.

## 7.2 REPL engine choice

Given Bun v1.3.10:

- Use Bun native REPL process as the runtime substrate.
- Manage it as a long-lived subprocess per agent session (or per run, then snapshot/restore).
- Keep a strict protocol boundary: script in, structured output out.

Note: `bun repl -e` is not enough (non-persistent command mode). We need a long-lived REPL session manager.

## 7.3 Print/commit contract

Mandatory behavior:

- raw REPL stdout/stderr do **not** automatically enter model context,
- only explicit commit payloads do (e.g., `print(...)` lines or `FINAL(...)` style marker),
- raw outputs are stored as artifacts for audit/debug and can be inspected on demand.

This is the core mechanism that prevents transcript bloat.

## 7.4 State persistence model

Persist at least:

- serializable variable map,
- metadata (timestamp, session id, workspace, branch/hash),
- optional compaction history / summaries.

Recommended storage:

- DB table or filesystem blob keyed by `(sessionId, workspaceId, stateVersion)`.

On restore:

- validate compatibility (workspace + branch heuristics),
- fallback to empty state if incompatible.

## 7.5 Recursive subcalls (`rlm_query` analogue)

Add an internal tool/API (example name `spawn_subagent`) with:

- inherited trace id,
- inherited global budget + timeout windows,
- depth counter and max depth,
- sync and async modes.

For async mode, preserve ypi's good pattern:

- return a handle immediately,
- later collect via `TaskOutput`/result fetch.

## 7.6 Events and observability additions

Add event types (example):

- `repl_session_restored`
- `repl_exec_start`
- `repl_exec_end`
- `repl_commit`
- `repl_snapshot_saved`
- `subagent_spawned`
- `subagent_completed`

These should coexist with current events (`message_*`, `turn_*`, `limit_hit`).

---

## 8) Incremental Migration Plan

## Phase 0: Instrumentation-first

- Measure how often `run_ptc_script` is used and output sizes.
- Add counters around tool-result context contribution.

## Phase 1: Persistent REPL runtime service

- Implement `ReplSessionManager` (spawn, reuse, teardown).
- Add protocol for code execution + bounded output capture.

## Phase 2: Commit-only context ingestion

- Introduce explicit commit channel (`print`/`FINAL`).
- Store raw artifacts outside transcript.

## Phase 3: Snapshot/restore across runs

- Persist serializable state.
- Restore on new run for same session/workspace.

## Phase 4: Recursive sub-agent API

- Add depth/call/budget/timeout propagation.
- Add async spawn + completion retrieval.

## Phase 5: Make REPL-first default loop

- Route most multi-step tasks through REPL by default.
- Keep direct tool path as fallback.

---

## 9) What to Copy Directly from ypi vs Adapt

## Copy directly (conceptually)

- Tree guardrail semantics (depth/call/timeout/budget).
- Trace ID propagation.
- Async subtask handle pattern.
- Session transcript introspection pattern.

## Adapt to Ellie implementation style

- Convert shell/env-script orchestration into typed TS services.
- Replace ad-hoc temp-file IPC with structured internal APIs.
- Integrate with existing EventStore and `limit_hit` path.
- Reuse existing guardrail policy ingestion from env.

---

## 10) Risks and Mitigations

| Risk                                    | Why it matters                                                | Mitigation                                                    |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| REPL protocol fragility                 | Parsing mixed output from long-lived process can drift        | Define explicit framing markers and strict parser tests       |
| State corruption or oversized snapshots | Cross-run persistence can become unstable                     | Size caps, schema versioning, safe fallback to empty state    |
| Hidden context leakage                  | If raw output leaks back to transcript, RLM advantage is lost | Enforce commit-only ingestion at one boundary in code         |
| Recursive runaway                       | Sub-agent trees can explode in cost/time                      | Reuse tree-wide depth/call/budget/timeout guardrails          |
| Security surface increase               | More autonomous execution patterns                            | Keep sandbox/permissions strict, preserve deny-first policies |

---

## 11) Immediate Build Scope (Suggested)

If we do only the highest leverage slice first:

1. Persistent REPL runtime (single-session, no recursion yet).
2. Commit-only context ingestion.
3. Cross-run snapshot/restore.

This already gives the main RLM behavior change without requiring full recursive delegation on day one.

---

## 12) Source Map

## Primary research

- CodeAct paper: https://arxiv.org/abs/2402.01030
- RLM paper: https://arxiv.org/abs/2512.24601
- RLM code/docs: https://github.com/alexzhang13/rlm
- Bun v1.3.10 release notes: https://bun.com/blog/bun-v1.3.10
- Bun REPL docs: https://bun.com/docs/runtime/repl
- Bun spawn reference: https://bun.com/reference/bun/spawn
- Claude Code architecture docs: https://code.claude.com/docs/en/how-claude-code-works.md
- Claude Code tools list: https://code.claude.com/docs/en/settings.md#tools-available-to-claude
- Claude Opus 4.5 system card (benchmarks): https://assets.anthropic.com/m/64823ba7485345a7/original/Claude-Opus-4-5-System-Card.pdf

## Local codebases audited

- Ellie:
  - `packages/agent/src/agent.ts`
  - `packages/agent/src/agent-loop.ts`
  - `packages/agent/src/types.ts`
  - `packages/agent/src/tool-safety.ts`
  - `packages/agent/test/agent-loop.test.ts`
  - `apps/server/src/agent/controller.ts`
  - `apps/server/src/agent/guardrail-policy.ts`
  - `apps/server/src/agent/tools/{shell-tool.ts,ripgrep-tool.ts,workspace-tools.ts,ptc/ptc-tool.ts}`
  - `packages/env/src/server.ts`
  - `packages/db/src/event-store.ts`
  - `packages/schemas/src/agent.ts`
- ypi:
  - `ypi`
  - `rlm_query`
  - `rlm_sessions`
  - `rlm_cost`
  - `rlm_parse_json`
  - `AGENTS.md`
  - `SYSTEM_PROMPT.md`

---

## 13) Bottom Line

Ellie is closer than it looks.

The guardrail, eventing, and tool substrate are already strong. The delta to RLM-first is primarily a **stateful execution model + context contract change**:

- persistent REPL state,
- commit-only context ingress,
- optional cross-run snapshot restore,
- recursive delegation under shared guardrails.

That is the path from "agent with script tool" to "RLM-first agent runtime".
