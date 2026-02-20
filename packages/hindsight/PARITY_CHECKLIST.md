# Hindsight Parity Checklist (PR #35)

Source-of-truth references:
- `/Users/shaul/Desktop/ai/memory/hindsight/hindsight-api/hindsight_api/engine/search/link_expansion_retrieval.py`
- `/Users/shaul/Desktop/ai/memory/hindsight/hindsight-api/hindsight_api/engine/retain/orchestrator.py`
- `/Users/shaul/Desktop/ai/memory/hindsight/hindsight-api/hindsight_api/engine/memory_engine.py`

## 1) Graph retrieval parity
- [x] Fallback expansion over `semantic|temporal|entity` links with half-weight scoring.
- [x] Semantic + temporal seed union behavior.
- [x] Directional causal traversal parity.
- [x] Tests in `src/__tests__/recall-methods.test.ts` for fallback + temporal seed merge + entity frequency filter behavior.

## 2) Retain link-creation parity
- [x] Temporal link creation in retain pipeline.
- [x] Preserve entity/causal/semantic link creation.
- [x] Add ordering/temporal regression tests in `src/__tests__/retain-ordering.test.ts`.

## 3) Recall API/behavior parity
- [x] Token budget path (`maxTokens`).
- [x] Optional payloads (`includeEntities`, `includeChunks`).
- [x] Chunk payload should prefer chunk table context when available.
- [x] Apply deterministic token budget for entity payload (`maxEntityTokens`).

## 4) Reflect tool parity
- [x] Add `expand` tool path for chunk/document context expansion.
- [x] Wire expand outputs to retained chunk/document metadata.

## 5) Batch retain input-surface parity
- [x] Add rich item overload (`content/context/event_date/document_id/tags/metadata`) while keeping `string[]` path.
- [x] Keep chonkie chunking and shared retain guarantees.

## 6) Documents/chunks subsystem parity
- [x] Schema: documents/chunks + memory unit references.
- [x] Retain persists document/chunk metadata.
- [x] Recall/expand can return chunk context.

## 7) Dedup parity
- [x] Add temporal-windowed dedup semantics (similarity + temporal proximity).

## 8) Consolidation context parity
- [x] Enrich consolidation prompt context with source temporal metadata and richer related-observation details.

## 9) Operational/admin API parity (scoped)
- [x] Expose document/chunk/graph inspection helpers on TS API surface for this PR scope.

## 10) Test closure + hardening
- [x] Convert selected parity `it.todo` cases in `consolidation.test.ts`, `retain.test.ts`, `recall.test.ts` that are directly affected by this implementation pass.
- [ ] Final gate: `bun run check-types` + full `bun test` in `packages/hindsight`.
