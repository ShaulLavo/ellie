# Thread/Branch Core Refactor

## Summary

- Replace the generic `session` model with a two-level conversation model: `thread` is the durable task/workspace container, `branch` is the append-only linear chat path inside that thread.
- Treat the current `session` implementation as a branch-shaped runtime and remove the idea that all chats share one generic rotating `current` pointer.
- Make assistant threads the simplest case: one active daily thread per default assistant and workspace, a single root branch, no fork support, old threads view-only.
- Make coding and research threads persistent and branchable: one thread per task/workspace, one root branch, explicit fork-from-message support, branch-local history and runtime state.
- Keep the event-sourced runtime, but scope it to `branchId` instead of `sessionId`. Do not normalize messages/tools/runs into separate transcript tables in this refactor.
- No backward compatibility. Replace the legacy session schema and routes; old local runtime data may be discarded.

## Key Changes

- Add `threads` with `id`, `agentId`, `agentType`, `workspaceId`, `title`, `state`, `dayKey`, `createdAt`, `updatedAt`.
- Add `branches` with `id`, `threadId`, `parentBranchId`, `forkedFromEventId`, `forkedFromSeq`, `currentSeq`, `createdAt`, `updatedAt`.
- Rename the current `sessions` role to `branches`, and rename `events.session_id` to `branch_id`. Keep the existing event payload model and append/update semantics.
- Add `thread_channels` with `threadId`, `channelId`, `accountId`, `conversationKey`, `attachedAt`, `detachedAt`. Routing uses rows with `detachedAt IS NULL`.
- Keep app-level pointer state in KV, not a new binding table. Store `assistant.defaultThreadId` and `assistant.defaultDayKey` for the default assistant only.
- Rename runtime-facing identifiers from `sessionId` to `branchId` everywhere they mean “linear execution history.” Add `threadId` to trace/run metadata where correlation matters.
- Remove `session_rotated` and generic `/current` behavior. Day rollover becomes assistant-thread creation plus default-thread pointer update, not a persisted chat event.

## Interfaces

- Replace generic session APIs with explicit thread/branch APIs:
- `GET /api/assistant/current` returns the default assistant `threadId` plus its sole `branchId`.
- `GET /api/assistant/current/sse` publishes current-thread changes for the assistant UI and CLI.
- `POST /api/threads` creates a thread and its root branch.
- `GET /api/threads` and `GET /api/threads/:threadId` return thread metadata; assistant old threads are included but marked `view_only`.
- `GET /api/threads/:threadId/branches` returns branch metadata for coding/research threads.
- `POST /api/branches/:branchId/messages`, `GET /api/branches/:branchId/events`, and `GET /api/branches/:branchId/events/sse` replace the session-scoped chat routes.
- `POST /api/branches/:branchId/fork` creates a child branch from a specific event/message in that branch.
- Agent control routes become branch-scoped: steer, abort, history, run-event streams all take `branchId`, not `sessionId`.
- Add optional cross-thread origin metadata on thread creation and agent-run requests: `originThreadId`, `originBranchId`, `originRunId`, `originAgentId`. This is foundation for assistant -> coding handoff, not a full workflow UI.

## Implementation Changes

- Rebuild the DB schema in one cut. Drop the legacy session tables and migrate the runtime to the new thread/branch tables; do not preserve old runtime data.
- Update the event store so appends, dedupe, run recovery, delivery checkpoints, speech claims, bootstrap state, and trace correlation are branch-scoped.
- Implement a branch lineage resolver: load ancestor branches from root to leaf, include each ancestor only up to the child’s `forkedFromSeq`, then append the current branch’s full event stream. This becomes the single source of truth for history loads and SSE snapshots.
- Subscribe live SSE only to the current branch. Ancestor branches are immutable for the child view after the fork cutoff and do not need live subscriptions.
- Make assistant thread policy explicit in server init: on startup or local-day change, resolve or create the default assistant daily thread for `(assistant/default, workspace=main, dayKey=today)`. Mark the previous assistant thread `view_only`, detach its channel rows, attach channels to the new thread, and publish an assistant-current-thread change event.
- Make manual “new assistant chat” create a new assistant thread immediately, set it as default for the day, mark the superseded thread `view_only`, and move channel attachments.
- Disallow fork creation for assistant threads in both API and UI. Assistant threads always have exactly one root branch.
- Keep coding/research thread creation explicit and workspace-bound. Root branch creation happens automatically with the thread; future forks always stay inside the same thread.
- Bind persistent runtime state to `branchId`. `session_exec`, REPL state, in-flight controller binding, and stale-run recovery all move from session scope to branch scope. Switching branches tears down persistent branch-local state.
- Make memory retention branch-local. Retain cursors key off `branchId`, and child branches only retain their own new events; inherited parent prefix is not duplicated into the child’s retain cursor.
- Keep existing one-shot code execution tools as-is for the first cut. This refactor lays the thread/branch and origin-metadata foundation; it does not replace `exec` or `session_exec` with hidden transient coding threads yet.
- Update web and CLI clients to bootstrap from `GET /api/assistant/current` for assistant mode, then operate only on explicit `threadId` and `branchId`. Remove all generic `current` magic from stream/message APIs.
- Rename user-facing “session” UI to “thread” for assistant history and “branch” where coding/research needs explicit fork awareness. Transcript and export names should include `threadId` and `branchId`.

## Test Plan

- Startup with no data creates one assistant daily thread, one root branch, and one default-assistant pointer.
- Restart on the same day reuses the same assistant thread; day rollover creates a new assistant thread and switches the current-assistant SSE stream.
- Manual “new assistant chat” creates a new thread, updates the default pointer, detaches channels from the old thread, and leaves the old thread view-only.
- Assistant old threads reject new messages and reject fork requests.
- Coding thread creation yields one root branch; sending messages to the root branch preserves current streaming and tool behavior.
- Forking from an older event creates a child branch whose resolved history includes parent events only through the fork point and excludes the parent tail after that point.
- Continuing the parent branch after a fork does not change the child branch context or SSE stream.
- Persistent REPL state survives repeated runs on the same branch and is reset when the target branch changes.
- Stale run recovery, live-delivery recovery, speech artifact claims, and trace lookup all operate on `branchId` without generic current-session state.
- Channel ingress and outbound delivery only resolve assistant threads; attempts to attach or route channels to coding/research threads fail validation.
- Web and CLI assistant clients follow `assistant/current` changes without relying on `/current` branch aliases.

## Assumptions and Defaults

- The default assistant agent id is `assistant/default`.
- The current product has one default workspace id, `main`. Threads still store `workspaceId` so multi-workspace support can be added later without another schema rewrite.
- One assistant daily thread exists per `(agentId, workspaceId, local dayKey)`.
- All assistant channels aggregate into the current assistant daily thread for that agent/workspace.
- Assistant history remains viewable forever but is never resumed for new input once superseded.
- Coding and research threads are explicitly created and selected; no global current thread is modeled for them.
- Tree visualization, multi-tab branch management, and hidden transient one-shot coding threads are out of scope for this refactor; the schema and origin metadata should make them straightforward follow-ups.
