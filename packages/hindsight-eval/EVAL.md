# Hindsight Eval Harness

Offline evaluation harness for measuring `@ellie/hindsight` recall quality. Uses the current `hybrid` retrieval mode (semantic + BM25 + graph + temporal with RRF fusion) as the baseline.

## Quick Start

```sh
# Run the baseline eval and generate reports
bun run --cwd packages/hindsight-eval eval:baseline

# Verify reproducibility (runs twice, compares metrics)
bun run --cwd packages/hindsight-eval eval:baseline:repro

# Run unit tests
bun test --cwd packages/hindsight-eval
```

## How It Works

1. **Load fixture** — Reads eval cases from `fixtures/assistant-baseline.v1.jsonl`
2. **For each case** — Creates a fresh SQLite DB, seeds pre-extracted facts via `retain()`, runs `recall()` with the specified query
3. **Score** — Applies scenario-specific metrics to the recall results
4. **Report** — Generates JSON + Markdown artifacts in `artifacts/eval/baseline/`

### Reproducibility Knobs

| Knob | Value | Purpose |
|------|-------|---------|
| Seed | 42 | Fixed for deterministic ID generation |
| TopK | 10 | Default result limit |
| Embeddings | Hash-based (16 dims) | NOT semantically meaningful — ensures deterministic vectors |
| Tie-breaking | (score DESC, id ASC) | Stable candidate ordering |
| Timestamps | UTC | Consistent across timezones |
| LLM | No-op mock | Seeds use pre-extracted facts, no LLM calls |

## Scenario Families

| Scenario | Cases | Primary Metric | Description |
|----------|-------|----------------|-------------|
| `follow_up_recall` | 3 | MRR | Recall user preferences and prior decisions |
| `temporal_narrative` | 2 | Ordering accuracy | Reconstruct timelines from memory |
| `dedup_conflict` | 2 | Contradiction retrieval rate | Handle conflicting/duplicate facts |
| `code_location_recall` | 2 | Path recall@k | Find where code lives in the repo |
| `token_budget_packing` | 2 | Fact retention rate | Pack maximum facts under token budget |

### Scenario Weights (Global Score)

```
follow_up_recall:     30%
temporal_narrative:    20%
dedup_conflict:        15%
code_location_recall:  20%
token_budget_packing:  15%
```

## Adding New Eval Cases

1. Append a new JSON line to `fixtures/assistant-baseline.v1.jsonl`:

```jsonl
{"id":"unique-id","scenario":"follow_up_recall","description":"What this tests","seedFacts":[{"content":"...","factType":"world","confidence":1.0}],"query":"...","expected":{"mustInclude":["substring"]},"constraints":{"topK":10}}
```

2. Run the baseline: `bun run --cwd packages/hindsight-eval eval:baseline`
3. Run repro check: `bun run --cwd packages/hindsight-eval eval:baseline:repro`
4. Commit the updated fixture and baseline artifacts together

### EvalCase Schema

```ts
interface EvalCase {
  id: string              // Unique case identifier
  scenario: Scenario      // One of the 5 scenario families
  description: string     // Human-readable description
  seedFacts: SeedFact[]   // Pre-extracted facts to seed into memory
  query: string           // The recall query to execute
  expected: {
    mustInclude?: string[]   // Substrings that MUST appear in results
    mustExclude?: string[]   // Substrings that must NOT appear
    orderedHints?: string[]  // Expected ordering (temporal scenarios)
  }
  constraints?: {
    tokenBudget?: number  // Max tokens for recall
    topK?: number         // Override default top-K
  }
}
```

## Comparing Before/After Runs

After making changes to Hindsight retrieval:

1. Ensure the committed baseline is present in `artifacts/eval/baseline/latest/`
2. Run the repro check: `bun run --cwd packages/hindsight-eval eval:baseline:repro`
3. If metrics changed, the repro check will report deltas per case

To generate a new baseline after intentional changes:

```sh
bun run --cwd packages/hindsight-eval eval:baseline
# Review the changes in artifacts/eval/baseline/latest/summary.md
# Commit the updated baseline if the changes are expected
```

## Output Structure

```
packages/hindsight-eval/
├── artifacts/
│   └── eval/
│       └── baseline/
│           ├── <timestamp>/
│           │   ├── results.json    # Machine-readable full report
│           │   └── summary.md      # Human-readable summary
│           └── latest/             # Copy of most recent run
│               ├── results.json
│               └── summary.md
├── fixtures/
│   └── assistant-baseline.v1.jsonl # Versioned dataset (immutable once baselined)
├── scripts/
│   ├── run-baseline.ts             # CLI: bun run eval:baseline
│   └── repro-check.ts             # CLI: bun run eval:baseline:repro
└── src/
    ├── types.ts                    # EvalCase, EvalReport, metric types
    ├── runner.ts                   # Deterministic pipeline
    ├── scoring.ts                  # Scenario-specific scorers
    ├── report.ts                   # JSON + Markdown generation
    ├── index.ts                    # Public exports
    └── test/
        ├── scoring.test.ts         # Metric math correctness
        ├── runner.test.ts          # Pipeline determinism + fixture parsing
        └── report.test.ts          # Report generation + formatting
```

## Dataset Versioning

- The fixture file is versioned: `assistant-baseline.v1.jsonl`
- Once a baseline is committed, the fixture becomes immutable for that version
- To evolve the dataset, create `v2` and update the runner config
- Metric definitions are contract — changing a scorer requires a new dataset version
