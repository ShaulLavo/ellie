# Hindsight First-Principles Parity Audit

Date: 2026-02-20  
TS target: `packages/hindsight/src`  
Python source of truth: `/Users/shaul/Desktop/ai/memory/hindsight/hindsight-api/hindsight_api/engine`

## Scope and method
- Compared Python engine behavior and API surface directly against TS implementation.
- Did not use test files to define parity.
- Compared by subsystem: retain pipeline, graph retrieval, recall scoring, reflect agent, consolidation, admin/ops APIs, schema.

## Parity status summary

## Already at or near parity
- Link expansion retrieval core behavior:
  - semantic seed + temporal seed union
  - entity-frequency filtering
  - directional causal expansion (seed `sourceId -> targetId`)
  - fallback expansion over `semantic|temporal|entity` links at half weight
  - observation traversal via `source_memory_ids`
- Batch retain core shape:
  - accepts rich item objects (`content/context/eventDate/documentId/tags/metadata`)
  - auto chunking at `600_000` chars
  - chunking via `@chonkiejs/core`
  - batch embedding path and single transaction writes
- Document/chunk persistence and retrieval:
  - `hs_documents`, `hs_chunks`, `memory_units.documentId/chunkId`
  - recall chunk payload and reflect expand support
- Consolidation action support:
  - `create`, `update`, `merge`, `skip` all present
  - source-memory temporal metadata passed into consolidation prompt

## Material parity gaps (from source behavior)

### P0 - API surface parity (memory_engine vs Hindsight class)
- Python exposes a much larger operational API not yet in TS:
  - `list_memory_units`, `get_memory_unit`
  - `delete_memory_unit`, `clear_observations`
  - `list_entities`, `get_entity_state`, `get_entity`
  - `list_tags` (with wildcard/pagination semantics)
  - `get_bank_stats`
  - operation APIs: `list_operations`, `get_operation_status`, `cancel_operation`
  - async submission APIs: `submit_async_retain`, `submit_async_consolidation`, `submit_async_refresh_mental_model`
  - bank updates: `update_bank`, `merge_bank_mission`
- TS currently exposes only a subset (core retain/recall/reflect/consolidate + docs/chunks/graph helpers).

### P0 - Recall scoring and trace model drift
- Python recall pipeline includes:
  - parallel retrieval timing model
  - combined score weighting (`cross_encoder`, normalized `rrf`, temporal proximity, recency)
  - richer trace payload with phase metrics and ranking internals
- TS recall currently:
  - RRF + optional rerank callback
  - simple token filtering and payload hydration
  - no equivalent combined-scoring trace model.

### P0 - Temporal query understanding drift
- Python query analyzer supports:
  - multilingual date phrases
  - named month/year ranges
  - day-of-week ("last Saturday"), weekend, fuzzy phrases ("couple of days ago")
- TS temporal extraction is regex-only and limited to simple English patterns.

### P1 - Reflect agent behavior drift
- Python reflect agent includes:
  - explicit tool-call loop state, tool-name normalization guards
  - done-call leakage cleanup and structured output extraction path
  - richer per-call traces and safety handling around malformed tool calls
- TS reflect uses a simpler SDK agent loop and does not mirror those guardrails/normalization behaviors.

### P1 - Async operation subsystem parity
- Python has `async_operations` lifecycle and worker-backed task submission.
- TS schema and API currently have no operation table/lifecycle.

### P1 - Tag/admin utilities parity
- Python has first-class tag listing/filter APIs (including wildcard semantics).
- TS supports tag filtering during retrieval but lacks tag management/listing endpoints.

### P2 - Configuration/auth extension parity
- Python memory engine includes tenant/auth extension hooks and operation validator hooks.
- TS does not implement this extension/auth abstraction.

## Recommended execution plan

1. **P0 API parity layer**
- Add missing read/write/admin methods to `hindsight.ts`.
- Add required types in `types.ts`.
- Add minimal DB support paths in `schema.ts` where required.

2. **P0 recall scoring/trace parity**
- Port combined scoring model into `recall.ts`.
- Add trace model objects and phase metrics outputs compatible with Python semantics.

3. **P0 temporal analyzer parity**
- Upgrade `temporal.ts` to support month/year, day-of-week, weekend, and fuzzy phrase ranges.
- Keep deterministic epoch output compatible with TS recall filters.

4. **P1 reflect agent parity hardening**
- Add tool-name normalization and malformed-tool fallback guards to `reflect.ts`.
- Add done-answer cleanup + optional structured-output extraction path.

5. **P1 operations subsystem**
- Add `hs_async_operations` schema and operation lifecycle methods.
- Add submit/status/cancel API endpoints in `hindsight.ts`.

6. **P1 tag utilities**
- Add `listTags` API with wildcard + pagination semantics in `hindsight.ts`.

7. **P2 extension hooks**
- Decide explicitly whether TS will support tenant/auth/operation validator hooks.
- If yes, add hook interface and call sites; if no, mark as intentional divergence.

## Decision needed before implementation
- Confirm whether we target:
  - strict parity with Python operational surface (includes async ops + admin APIs), or
  - core memory-path parity only (retain/recall/reflect/consolidate + docs/chunks).
