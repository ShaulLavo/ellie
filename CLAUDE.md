# Ellie

AI chat application built on a custom Durable Streams protocol for real-time, persistent messaging.

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
| `apps/app` | Bun HTTP server — serves the Studio SPA, handles stream routes and RPC |
| `apps/studio` | React 19 chat UI — uses `useStream` hook for real-time subscriptions |

### Packages

| Package | What it does |
|---|---|
| `@ellie/rpc` | Type-safe RPC framework: `createRouter()` (server), `createRpcClient()` (client), `useStream()` (React) |
| `@ellie/router` | App-specific router definition — connects chat routes to schemas |
| `@ellie/durable-streams` | Core streaming backend — `DurableStore`, subscriptions, producer state, HTTP handler |
| `@ellie/streams-client` | HTTP client for the Durable Streams protocol — `DurableStream`, `IdempotentProducer` |
| `@ellie/streams-state` | State management via TanStack DB integration with streams |
| `@ellie/db` | Drizzle ORM + Bun SQLite — also `JsonlEngine` for hybrid SQLite metadata + JSONL message storage |
| `@ellie/ai` | LLM wrapper — model registry, cost calculation, TanStack AI integration |
| `@ellie/env` | Validated env vars via Valibot — `@ellie/env/server` and `@ellie/env/client` subpaths |
| `@repo/typescript-config` | Shared tsconfig bases |

## Key Architecture

Data flow: React (`useStream`) → RPC client → HTTP fetch → Bun server → DurableStore → JsonlEngine → SQLite (metadata) + JSONL files (messages).

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
| [agent_docs/rpc-layer.md](agent_docs/rpc-layer.md) | Working on the RPC framework, router, client proxy, or `useStream` hook |

## Conventions

- Use **Valibot** for all schema validation — never Zod
- Use **Standard Schema v1** spec in the RPC layer for universal validator support
- Package imports use `@ellie/*` scope (except `@repo/typescript-config`)
- Server entry point is `apps/app/src/server.ts`
- Environment variables are validated on import via `@ellie/env`
