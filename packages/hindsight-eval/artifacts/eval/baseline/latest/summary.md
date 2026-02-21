# Hindsight Eval Baseline Report

**Dataset:** assistant-baseline.v1
**Mode:** hybrid
**Seed:** 42
**Top-K:** 10
**Git SHA:** `388628fa000ff9dec92ffeeb4539aebb9b8cd752`
**Bun:** 1.3.10
**Timestamp:** 2026-02-21T22:19:32.273Z
**Total Duration:** 426ms

## Global Score: 81.3%

### Scenario Weights

| Scenario | Weight | Primary Metric |
|----------|--------|----------------|
| follow_up_recall | 30% | mrr |
| temporal_narrative | 20% | orderingAccuracy |
| dedup_conflict | 15% | contradictionRetrievalRate |
| code_location_recall | 20% | pathRecall@k |
| token_budget_packing | 15% | factRetentionRate |

## Scenario Results

### follow_up_recall (5 cases)

| Metric | Value |
|--------|-------|
| recall@1 | 43.3% |
| recall@3 | 83.3% |
| recall@5 | 100.0% |
| mrr | 64.4% |

### temporal_narrative (5 cases)

| Metric | Value |
|--------|-------|
| orderingAccuracy | 70.0% |
| predecessorHitRate | 65.0% |
| successorHitRate | 65.0% |
| recall@5 | 100.0% |

### dedup_conflict (5 cases)

| Metric | Value |
|--------|-------|
| duplicateLeakRate (lower is better) | 100.0% |
| contradictionRetrievalRate | 100.0% |
| recall@5 | 100.0% |

### code_location_recall (5 cases)

| Metric | Value |
|--------|-------|
| pathRecall@k | 100.0% |
| exactPathPrecision | 36.0% |
| mrr | 50.8% |

### token_budget_packing (5 cases)

| Metric | Value |
|--------|-------|
| factRetentionRate | 86.7% |
| truncationLossRate (lower is better) | 13.3% |
| budgetUtilization | 67.2% |

## Case Details

### fur-001 (follow_up_recall)

**Query:** What are the user's preferences?
**Duration:** 33ms
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
**Duration:** 13ms
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
**Duration:** 8ms
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

### fur-004 (follow_up_recall)

**Query:** How did we debug and fix the memory leak?
**Duration:** 9ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The memory leak was traced to unclosed database connections ... | semantic, fulltext |
| 2 | 0.5067 | Running the app with --inspect flag and taking heap snapshot... | semantic, fulltext |
| 3 | 0.5067 | The fix was adding a finally block to close connections afte... | semantic, fulltext |
| 4 | 0.0600 | The leak only manifested after 1000+ requests in production | semantic, fulltext |
| 5 | 0.0600 | We added a connection pool monitor that logs active connecti... | semantic, fulltext |

**Metrics:**

- recall@1: 33.3%
- recall@3: 100.0%
- recall@5: 100.0%
- mrr: 61.1%

### fur-005 (follow_up_recall)

**Query:** What are our deployment practices?
**Duration:** 8ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Blue-green deployments are used to minimize downtime | semantic, fulltext |
| 2 | 0.8006 | Deployment windows are Tuesday through Thursday, 10am-2pm ES... | semantic, fulltext |
| 3 | 0.0835 | We always deploy to staging first before production | semantic |
| 4 | 0.0716 | Hotfixes can be deployed anytime with two approvers | semantic |
| 5 | 0.0600 | Rollbacks should be triggered if error rate exceeds 1% withi... | semantic |

**Metrics:**

- recall@1: 33.3%
- recall@3: 66.7%
- recall@5: 100.0%
- mrr: 51.1%

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
- predecessorHitRate: 75.0%
- successorHitRate: 75.0%
- recall@5: 100.0%

### tn-002 (temporal_narrative)

**Query:** How did our database choice evolve?
**Duration:** 9ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Discovered SQLite with WAL mode handles our write patterns b... | semantic, fulltext |
| 2 | 0.8600 | Initially chose PostgreSQL for the database layer | semantic, fulltext |
| 3 | 0.8238 | Current database stack is SQLite with FTS5 and sqlite-vec | semantic, fulltext |
| 4 | 0.0712 | Added sqlite-vec extension for vector similarity search | semantic |
| 5 | 0.0600 | Migrated from PostgreSQL to SQLite in week 3 | semantic |

**Metrics:**

- orderingAccuracy: 60.0%
- predecessorHitRate: 25.0%
- successorHitRate: 25.0%
- recall@5: 100.0%

### tn-003 (temporal_narrative)

**Query:** How did the dark mode feature flag roll out?
**Duration:** 7ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | First flag dark-mode-v2 was created on March 5th for interna... | semantic, fulltext |
| 2 | 0.8534 | Feature flag system was introduced on March 1st using Launch... | semantic, fulltext |
| 3 | 0.4756 | Rolled out dark-mode-v2 to 10% of users on March 10th | semantic, fulltext |
| 4 | 0.0660 | Increased dark-mode-v2 to 50% on March 15th after positive f... | semantic, fulltext |
| 5 | 0.0600 | Full rollout of dark-mode-v2 to 100% on March 20th | semantic, fulltext |

**Metrics:**

- orderingAccuracy: 100.0%
- predecessorHitRate: 100.0%
- successorHitRate: 100.0%
- recall@5: 100.0%

### tn-004 (temporal_narrative)

**Query:** What happened during the March 4th incident?
**Duration:** 9ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Rollback of the migration was completed at 3:10 AM | semantic, fulltext |
| 2 | 0.8482 | Post-incident review was held on March 5th at 10 AM | semantic, fulltext |
| 3 | 0.8475 | On-call engineer acknowledged the alert at 2:22 AM | semantic, fulltext |
| 4 | 0.0953 | Root cause identified as a bad database migration at 2:45 AM | semantic |
| 5 | 0.0600 | Alert fired at 2:15 AM for elevated 500 error rates | semantic |

**Metrics:**

- orderingAccuracy: 30.0%
- predecessorHitRate: 50.0%
- successorHitRate: 50.0%
- recall@5: 100.0%

### tn-005 (temporal_narrative)

**Query:** How has our sprint process changed over time?
**Duration:** 6ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Sprint 7 added retrospective action items tracking in Linear | semantic, fulltext |
| 2 | 0.2787 | Sprint 1 used two-week cycles with daily standups | semantic, fulltext |
| 3 | 0.0722 | Sprint 3 switched to one-week cycles after feedback about co... | semantic, fulltext |
| 4 | 0.0600 | Sprint 5 introduced async standups via Slack bot instead of ... | semantic, fulltext |
| 5 | 0.0600 | Sprint 9 adopted shape-up style cool-down weeks between cycl... | semantic, fulltext |

**Metrics:**

- orderingAccuracy: 70.0%
- predecessorHitRate: 75.0%
- successorHitRate: 75.0%
- recall@5: 100.0%

### dc-001 (dedup_conflict)

**Query:** What is the current API rate limit?
**Duration:** 18ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The API rate limit is 100 requests per minute | semantic, fulltext |
| 2 | 0.8428 | The API rate limit is 100 requests per minute | semantic, fulltext |
| 3 | 0.6072 | Premium tier users have a rate limit of 1000 requests per mi... | semantic, fulltext |
| 4 | 0.5820 | The API rate limit was increased to 500 requests per minute ... | semantic, fulltext |
| 5 | 0.0600 | Rate limiting is enforced at the nginx level using the limit... | semantic, fulltext |

**Metrics:**

- duplicateLeakRate: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### dc-002 (dedup_conflict)

**Query:** How does our deployment pipeline work?
**Duration:** 12ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Deployments are triggered automatically on merge to main | semantic, fulltext |
| 2 | 0.8482 | The CI/CD pipeline runs on GitHub Actions | semantic, fulltext |
| 3 | 0.8475 | The deployment uses Docker containers on AWS ECS | semantic, fulltext |
| 4 | 0.0953 | Docker images are built and pushed by GitHub Actions CI/CD | semantic |
| 5 | 0.0600 | We deploy using Docker containers on Amazon ECS | semantic |

**Metrics:**

- duplicateLeakRate: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### dc-003 (dedup_conflict)

**Query:** Where is our application deployed?
**Duration:** 11ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The application is deployed in us-east-1 region | semantic, fulltext |
| 2 | 0.8592 | A CDN edge layer is deployed globally via CloudFront | semantic, fulltext |
| 3 | 0.8592 | The application is deployed in us-east-1 region | semantic, fulltext |
| 4 | 0.1085 | We migrated the primary deployment to eu-west-1 for GDPR com... | semantic |
| 5 | 0.0600 | Disaster recovery replica runs in ap-southeast-1 | semantic |

**Metrics:**

- duplicateLeakRate: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### dc-004 (dedup_conflict)

**Query:** When is the team standup?
**Duration:** 8ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Team standup is at 9:00 AM every weekday | semantic, fulltext |
| 2 | 0.8600 | Team standup was moved to 9:30 AM starting February | semantic, fulltext |
| 3 | 0.8596 | Team standup is at 9:00 AM every weekday | semantic, fulltext |
| 4 | 0.7996 | Sprint planning is every other Monday at 10:00 AM | semantic, fulltext |
| 5 | 0.0600 | Design review happens every Wednesday at 2:00 PM | semantic |

**Metrics:**

- duplicateLeakRate: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### dc-005 (dedup_conflict)

**Query:** What is the max file upload size?
**Duration:** 10ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Max upload size was increased to 25MB after adding S3 direct... | semantic, fulltext |
| 2 | 0.5045 | The max upload file size is 5MB | semantic, fulltext |
| 3 | 0.5045 | Uploads are virus-scanned by ClamAV before storage | semantic, fulltext |
| 4 | 0.4663 | The max upload file size is 5MB | semantic, fulltext |
| 5 | 0.0600 | Images are automatically resized to 1200px max width on uplo... | semantic, fulltext |

**Metrics:**

- duplicateLeakRate: 100.0%
- contradictionRetrievalRate: 100.0%
- recall@5: 100.0%

### clr-001 (code_location_recall)

**Query:** Where is the authentication code?
**Duration:** 13ms
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
**Duration:** 11ms
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

### clr-003 (code_location_recall)

**Query:** Where are the tests for the RPC and streaming packages?
**Duration:** 11ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Agent conversation loop tests are in packages/agent/src/test... | semantic, fulltext |
| 2 | 0.7275 | Unit tests for the RPC layer are in packages/rpc/src/test/ro... | semantic, fulltext |
| 3 | 0.7187 | Integration tests for streams are in packages/durable-stream... | semantic, fulltext |
| 4 | 0.5862 | Database schema tests live in packages/db/src/test/schema.te... | semantic, fulltext |
| 5 | 0.0600 | End-to-end tests are in apps/app/src/test/e2e/ | semantic, fulltext |

**Metrics:**

- pathRecall@k: 100.0%
- exactPathPrecision: 40.0%
- mrr: 41.7%

### clr-004 (code_location_recall)

**Query:** Where are the TypeScript and build configuration files?
**Duration:** 10ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Turbo pipeline config is at turbo.json in the repo root | semantic, fulltext |
| 2 | 0.8600 | TypeScript base config is at packages/typescript-config/base... | semantic, fulltext |
| 3 | 0.8238 | Environment validation schemas are in packages/env/src/schem... | semantic, fulltext |
| 4 | 0.0842 | Drizzle ORM config is at packages/db/drizzle.config.ts | semantic |
| 5 | 0.0600 | Tailwind config is at apps/studio/tailwind.config.ts | semantic |

**Metrics:**

- pathRecall@k: 100.0%
- exactPathPrecision: 40.0%
- mrr: 75.0%

### clr-005 (code_location_recall)

**Query:** Where is the CORS and error handling middleware?
**Duration:** 10ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Error handling middleware lives in packages/api/src/middlewa... | semantic, fulltext |
| 2 | 0.8600 | The middleware composition utility is in packages/api/src/mi... | semantic, fulltext |
| 3 | 0.5338 | CORS middleware is defined in packages/api/src/middleware/co... | semantic, fulltext |
| 4 | 0.3808 | Health check endpoint is at packages/api/src/routes/health.t... | semantic, fulltext |
| 5 | 0.0600 | Request logging middleware is in packages/api/src/middleware... | semantic, fulltext |

**Metrics:**

- pathRecall@k: 100.0%
- exactPathPrecision: 40.0%
- mrr: 66.7%

### tbp-001 (token_budget_packing)

**Query:** What is the tech stack?
**Duration:** 19ms
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
**Duration:** 27ms
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

### tbp-003 (token_budget_packing)

**Query:** What are the user's coding style preferences?
**Duration:** 13ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | User prefers named exports over default exports | semantic, fulltext |
| 2 | 0.8244 | User prefers tabs over spaces with width of 2 | semantic, fulltext |
| 3 | 0.1043 | User wants all imports sorted alphabetically | semantic |
| 4 | 0.0815 | User avoids classes in favor of plain functions | semantic |
| 5 | 0.0706 | User always uses const instead of let when possible | semantic |

**Metrics:**

- factRetentionRate: 66.7%
- truncationLossRate: 33.3%
- budgetUtilization: 75.0%

### tbp-004 (token_budget_packing)

**Query:** How is the project CI/CD set up?
**Duration:** 13ms
**Candidates:** 5

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | The project uses pnpm workspaces for package management | semantic, fulltext |
| 2 | 0.8592 | The office coffee machine was recently upgraded | semantic, fulltext |
| 3 | 0.8592 | The team celebrates birthdays with cake on Fridays | semantic, fulltext |
| 4 | 0.8122 | Docker images are based on the official Node 20 alpine image | semantic, fulltext |
| 5 | 0.1189 | Pre-commit hooks run lint and type-check via husky | semantic |

**Metrics:**

- factRetentionRate: 66.7%
- truncationLossRate: 33.3%
- budgetUtilization: 55.8%

### tbp-005 (token_budget_packing)

**Query:** How is the production database configured?
**Duration:** 12ms
**Candidates:** 3

| Rank | Score | Content (truncated) | Sources |
|------|-------|---------------------|---------|
| 1 | 0.8600 | Database schema migrations are managed by Drizzle Kit | semantic, fulltext |
| 2 | 0.8479 | The production database connection string uses SSL mode requ... | semantic, fulltext |
| 3 | 0.8467 | The database uses connection pooling with max 20 connections | semantic, fulltext |

**Metrics:**

- factRetentionRate: 100.0%
- truncationLossRate: 0.0%
- budgetUtilization: 90.0%
