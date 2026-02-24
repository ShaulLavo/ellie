# Ellie

AI chat application using Elysia routes + SSE for real-time messaging, with JSONL-backed persistence.

## Stack

- **Runtime**: Bun
- **Monorepo**: Turborepo with Bun workspaces
- **Language**: TypeScript 5.9
- **Validation**: Valibot (not Zod)
- **Linter**: oxlint
- **Formatter**: Prettier

## Project Map

### Apps

| App | What it does |
|---|---|
| `apps/app` | Bun + Elysia HTTP server — serves the React SPA and handles REST/SSE routes |
| `apps/react` | React 19 chat UI — subscribes over SSE and calls typed Elysia endpoints |

### Packages

| Package | What it does |
|---|---|
| `@ellie/agent` | Stateful AI agent — conversation loop, tool execution, event streaming, steering/follow-up queues |
| `@ellie/streams` | Consolidated streams package: `stream-server`, `stream-client`, `stream-state`, `router`, and `rpc` modules |
| `@ellie/db` | Drizzle ORM + Bun SQLite — also `JsonlEngine` for hybrid SQLite metadata + JSONL message storage |
| `@ellie/ai` | LLM wrapper — model registry, cost calculation, TanStack AI integration |
| `@ellie/env` | Validated env vars via Valibot — `@ellie/env/server` and `@ellie/env/client` subpaths |
| `@repo/typescript-config` | Shared tsconfig bases |

## Key Architecture

Data flow: React (SSE + fetch) → Elysia routes → RealtimeStore/AgentManager → JsonlEngine → SQLite metadata + JSONL files.

Producers use epoch/sequence tracking for idempotent appends. Subscriptions are in-memory per-client callbacks. No in-memory message cache — reads always hit disk.

## Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev all apps (turbo)
bun run build        # Build all (turbo)
bun run check-types  # Typecheck all (turbo)
bun run test         # Test all (turbo)
bun run lint         # oxlint
bun run lint:fix     # oxlint --fix
bun run format       # Prettier
```

Use `--filter=<app|package>` with turbo commands to target specific packages.

## Deep Dives

Read these before working on the relevant subsystem:

| Doc | When to read |
|-----|--------------|
| [agent_docs/durable-streams.md](agent_docs/durable-streams.md) | Working on the streaming protocol, subscriptions, producers, or HTTP handlers |
| [agent_docs/database.md](agent_docs/database.md) | Working on storage, schema, JSONL files, or the JsonlEngine |
| [agent_docs/jsonl-logger.md](agent_docs/jsonl-logger.md) | Working on JSONL persistence, LogFile, JsonlEngine, TypedLog, or on-disk format |
| [agent_docs/ai-package.md](agent_docs/ai-package.md) | Working on LLM integration, model registry, cost calculation, or thinking support |

## Conventions

- Use **Valibot** for all schema validation — never Zod
- Use **Standard Schema v1** compatible validators (Valibot) for route schemas
- Package imports use `@ellie/*` scope (except `@repo/typescript-config`)
- Server entry point is `apps/app/src/server.ts`
- Environment variables are validated on import via `@ellie/env`
