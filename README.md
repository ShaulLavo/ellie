# Ellie

Personal AI assistant — a local-first, event-sourced agent platform.

## Structure

| Path                 | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `apps/server`        | Elysia backend (Bun) — agent orchestration, SSE, REST API    |
| `apps/web`           | React frontend (`@ellie/web`) — chat UI, DB studio           |
| `apps/cli`           | Go CLI — authentication, dev workflow                        |
| `packages/agent`     | Agent loop, tool execution, loop detection                   |
| `packages/ai`        | LLM adapters, credentials, OAuth                             |
| `packages/db`        | SQLite event store, schemas, migrations                      |
| `packages/env`       | Shared environment config                                    |
| `packages/hindsight` | Episodic memory — entity extraction, recall, temporal search |
| `packages/schemas`   | Valibot schemas shared across packages                       |
| `packages/tus`       | Resumable file upload (tus protocol)                         |

## Development

```sh
# Start the server (hot-reload)
bun run --hot apps/server/src/server.ts

# Run tests (server + packages only)
bun test --filter './packages/*' --filter './apps/server/*'
```

## Speech

- STT uses `STT_BASE_URL` for transcription.
- ElevenLabs TTS uses `ELEVENLABS_API_KEY` (or `XI_API_KEY`).
- Optional TTS defaults: `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `TTS_TIMEOUT_MS`, `TTS_MAX_TEXT_LENGTH`.

## Architecture

- **Event sourcing**: all state changes stored as events in SQLite via `EventStore`
- **Real-time**: SSE streams via `RealtimeStore` pub/sub
- **Agent loop**: message → AgentController → Agent → tool calls → events → SSE → client
- **Memory**: episodic memory via Hindsight (entity extraction, temporal recall, embeddings)
