# Hindsight Eval Baseline Report

**Dataset:** assistant-baseline.v1
**Mode:** hybrid
**Seed:** 42
**Top-K:** 10
**Git SHA:** `11058e3754cc6118ab7bc81d0da6f3121d860d58`
**Bun:** 1.3.10
**Timestamp:** 2026-02-21T15:12:03.916Z
**Total Duration:** 469ms

## Global Score: 87.0%

### Scenario Weights

| Scenario | Weight | Primary Metric |
|----------|--------|----------------|
| follow_up_recall | 30% | mrr |
| temporal_narrative | 20% | orderingAccuracy |
| dedup_conflict | 15% | contradictionRetrievalRate |
| code_location_recall | 20% | pathRecall@k |
| token_budget_packing | 15% | factRetentionRate |

## Scenario Results

### follow_up_recall (3 cases)

| Metric | Value |
|--------|-------|
| recall@1 | 50.0% |
| recall@3 | 83.3% |
| recall@5 | 100.0% |
| mrr | 70.0% |

### temporal_narrative (2 cases)

| Metric | Value |
|--------|-------|
| orderingAccuracy | 80.0% |
| predecessorHitRate | 100.0% |
| successorHitRate | 100.0% |
| recall@5 | 100.0% |

### dedup_conflict (2 cases)

| Metric | Value |
|--------|-------|
| duplicateHitRatio | 50.0% |
| contradictionRetrievalRate | 100.0% |
| recall@5 | 100.0% |

### code_location_recall (2 cases)

| Metric | Value |
|--------|-------|
| pathRecall@k | 100.0% |
| exactPathPrecision | 30.0% |
| mrr | 35.4% |

### token_budget_packing (2 cases)

| Metric | Value |
|--------|-------|
| factRetentionRate | 100.0% |
| truncationLossRate | 0.0% |
| budgetUtilization | 57.5% |

## Case Details

### fur-001 (follow_up_recall)

**Query:** What are the user's preferences?
**Duration:** 35ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | User prefers dark mode in all applications | semantic, fulltext |
| 2 | 0.8369 | User's project uses Bun as the runtime | semantic, fulltext |
| 3 | 0.8354 | User's favorite editor is VS Code with Vim keybindings | semantic, fulltext |
| 4 | 0.0970 | User works primarily with TypeScript and React | semantic |
| 5 | 0.0600 | User dislikes auto-formatting on save | semantic |

**Metrics:**

- recall@1: 50.0%
- recall@3: 50.0%
- recall@5: 100.0%
- mrr: 60.0%

### fur-002 (follow_up_recall)

**Query:** Why did we switch from Zod to Valibot?
**Duration:** 23ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The migration from Zod to Valibot reduced bundle size by 40% | semantic, fulltext |
| 2 | 0.5488 | Team decided to use Valibot instead of Zod for schema valida... | semantic, fulltext |
| 3 | 0.5488 | Valibot supports Standard Schema v1 spec natively | semantic, fulltext |
| 4 | 0.2506 | All new schemas must use Valibot going forward | semantic, fulltext |
| 5 | 0.0600 | Legacy Zod schemas remain in the auth module until Q2 refact... | semantic, fulltext |

**Metrics:**

- recall@1: 50.0%
- recall@3: 100.0%
- recall@5: 100.0%
- mrr: 75.0%

### fur-003 (follow_up_recall)

**Query:** What was the WebSocket issue and how did we fix it?
**Duration:** 11ms
**Candidates:** 4

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Increasing the proxy keep-alive to 120s fixed the WebSocket ... | semantic, fulltext |
| 2 | 0.8596 | The WebSocket connection drops every 30 seconds due to a pro... | semantic, fulltext |
| 3 | 0.8213 | The server runs behind an nginx reverse proxy | semantic, fulltext |
| 4 | 0.0600 | Server-sent events work fine because they reconnect automati... | semantic |

**Metrics:**

- recall@1: 50.0%
- recall@3: 100.0%
- recall@5: 100.0%
- mrr: 75.0%

### tn-001 (temporal_narrative)

**Query:** What is the project timeline?
**Duration:** 10ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Project kickoff meeting held on January 5th | semantic, fulltext |
| 2 | 0.1071 | Initial architecture review completed January 12th | semantic |
| 3 | 0.0828 | First prototype deployed to staging January 19th | semantic |
| 4 | 0.0712 | Production release scheduled for February 2nd | semantic |
| 5 | 0.0600 | User testing began January 26th with 5 beta testers | semantic |

**Metrics:**

- orderingAccuracy: 90.0%
- predecessorHitRate: 100.0%
- successorHitRate: 100.0%
- recall@5: 100.0%

### tn-002 (temporal_narrative)

**Query:** How did our database choice evolve?
**Duration:** 11ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Initially chose PostgreSQL for the database layer | semantic, fulltext |
| 2 | 0.8600 | Discovered SQLite with WAL mode handles our write patterns b... | semantic, fulltext |
| 3 | 0.8238 | Current database stack is SQLite with FTS5 and sqlite-vec | semantic, fulltext |
| 4 | 0.0712 | Added sqlite-vec extension for vector similarity search | semantic |
| 5 | 0.0600 | Migrated from PostgreSQL to SQLite in week 3 | semantic |

**Metrics:**

- orderingAccuracy: 70.0%
- predecessorHitRate: 100.0%
- successorHitRate: 100.0%
- recall@5: 100.0%

### dc-001 (dedup_conflict)

**Query:** What is the current API rate limit?
**Duration:** 13ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The API rate limit is 100 requests per minute | semantic, fulltext |
| 2 | 0.8428 | The API rate limit is 100 requests per minute | semantic, fulltext |
| 3 | 0.6072 | Premium tier users have a rate limit of 1000 requests per mi... | semantic, fulltext |
| 4 | 0.5820 | The API rate limit was increased to 500 requests per minute ... | semantic, fulltext |
| 5 | 0.0600 | Rate limiting is enforced at the nginx level using the limit... | semantic, fulltext |

**Metrics:**

- duplicateHitRatio: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### dc-002 (dedup_conflict)

**Query:** How does our deployment pipeline work?
**Duration:** 14ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Deployments are triggered automatically on merge to main | semantic, fulltext |
| 2 | 0.8482 | The CI/CD pipeline runs on GitHub Actions | semantic, fulltext |
| 3 | 0.8475 | The deployment uses Docker containers on AWS ECS | semantic, fulltext |
| 4 | 0.0953 | Docker images are built and pushed by GitHub Actions CI/CD | semantic |
| 5 | 0.0600 | We deploy using Docker containers on Amazon ECS | semantic |

**Metrics:**

- duplicateHitRatio: 0.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### clr-001 (code_location_recall)

**Query:** Where is the authentication code?
**Duration:** 12ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The main server entry point is apps/app/src/server.ts | semantic, fulltext |
| 2 | 0.8242 | Authentication middleware is defined in packages/auth/src/mi... | semantic, fulltext |
| 3 | 0.8231 | Rate limiting is implemented in packages/api/src/rate-limite... | semantic, fulltext |
| 4 | 0.8108 | The JWT token validation logic lives in packages/auth/src/jw... | semantic, fulltext |
| 5 | 0.0600 | Database migrations are stored in packages/db/drizzle/ | semantic |

**Metrics:**

- pathRecall@k: 100.0%
- exactPathPrecision: 40.0%
- mrr: 37.5%

### clr-002 (code_location_recall)

**Query:** What does the @ellie/agent package do?
**Duration:** 14ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The @ellie/hindsight package implements biomimetic agent mem... | semantic, fulltext |
| 2 | 0.8547 | The @ellie/durable-streams package provides the streaming ba... | semantic, fulltext |
| 3 | 0.5491 | The @ellie/agent package contains the stateful AI agent loop... | semantic, fulltext |
| 4 | 0.3709 | The @ellie/rpc package handles type-safe RPC with createRout... | semantic, fulltext |
| 5 | 0.0600 | The @ellie/db package wraps Drizzle ORM with Bun SQLite and ... | semantic, fulltext |

**Metrics:**

- pathRecall@k: 100.0%
- exactPathPrecision: 20.0%
- mrr: 33.3%

### tbp-001 (token_budget_packing)

**Query:** What is the tech stack?
**Duration:** 23ms
**Candidates:** 7

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Formatting is handled by Prettier with default config | semantic, fulltext |
| 2 | 0.8484 | The frontend is React 19 with TanStack Router for navigation | semantic, fulltext |
| 3 | 0.8033 | The test runner is Bun's built-in test framework | semantic, fulltext |
| 4 | 0.8013 | The server uses Bun HTTP with a custom router | semantic, fulltext |
| 5 | 0.1057 | Linting uses oxlint for fast TypeScript linting | semantic |
| 6 | 0.0937 | State management uses TanStack DB for reactive collections | semantic |
| 7 | 0.0600 | WebSocket connections are managed via Durable Streams protoc... | semantic |

**Metrics:**

- factRetentionRate: 100.0%
- truncationLossRate: 0.0%
- budgetUtilization: 48.0%

### tbp-002 (token_budget_packing)

**Query:** Tell me about Alice's engineering background
**Duration:** 28ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Alice's team meets every Tuesday for sprint planning | semantic, fulltext |
| 2 | 0.8255 | User's name is Alice and she is a senior engineer | semantic, fulltext |
| 3 | 0.1358 | Alice prefers functional programming patterns over OOP | semantic |
| 4 | 0.1124 | Alice is currently leading the migration to TypeScript 5.9 | semantic |
| 5 | 0.0905 | Alice has 8 years of experience with JavaScript | semantic |

**Metrics:**

- factRetentionRate: 100.0%
- truncationLossRate: 0.0%
- budgetUtilization: 67.0%
