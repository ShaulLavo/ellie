# Hindsight Parity Checklist

Date: 2026-02-20  
Source of truth: `/Users/shaul/Desktop/ai/memory/hindsight/hindsight-api/hindsight_api/engine`

## Core parity targets

- [x] Graph retrieval parity (link expansion + seed union + directional causal + fallback scoring)
- [x] Batch retain parity (rich batch items, 600K auto-chunking, chonkiejs, batch embedding, single transaction)
- [x] Consolidation merge action parity (`create` / `update` / `merge` / `skip`)
- [x] Async operation subsystem parity (`hs_async_operations`, submit/list/status/cancel)

## API surface parity (`memory_engine` vs TS `Hindsight`)

- [x] `listMemoryUnits`
- [x] `getMemoryUnit`
- [x] `deleteMemoryUnit`
- [x] `clearObservations`
- [x] `listEntities`
- [x] `getEntityState`
- [x] `getEntity`
- [x] `listTags` (wildcard + pagination)
- [x] `getBankStats`
- [x] `updateBank`
- [x] `mergeBankMission`

## Recall parity

- [x] Combined scoring model parity (`cross-encoder` + normalized `rrf` + temporal + recency)
- [x] Token-budget retrieval mode (`maxTokens`)
- [x] Optional recall payloads (`includeEntities`, `includeChunks`)
- [x] Recall trace payload with retrieval timings + ranking internals

## Temporal query analyzer parity

- [x] Month/year range parsing
- [x] Day-of-week parsing (e.g. `last saturday`)
- [x] Weekend parsing (`last weekend`)
- [x] Fuzzy relative phrases (`couple/few ... ago`)
- [x] Multilingual temporal keywords baseline

## Reflect parity

- [x] Expand-style context drill-down path (chunk/document)
- [x] Tool-path hardening (`recall` alias + robust expand arg normalization)
- [x] Done-answer leakage cleanup
- [x] Optional structured output extraction (`responseSchema`)
- [x] Reflect tool-call trace payload

## Extensions/auth hooks parity

- [x] Added extension hooks in config (`resolveTenantId`, `authorize`, `validate`, `onComplete`)
- [x] Wired hooks through core ops + async submit ops

## Operational/admin API tests

- [ ] Keep admin-api tests as TODO (per current PR scope)
