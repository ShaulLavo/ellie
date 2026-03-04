import { resolve } from 'node:path'
import {
	anthropicOAuth,
	refreshNormalizedOAuthToken
} from '@ellie/ai/anthropic-oauth'
import {
	loadAnthropicCredential,
	loadGroqCredential,
	setAnthropicCredential
} from '@ellie/ai/credentials'
import { groqChat } from '@ellie/ai/openai-compat'
import { EventStore } from '@ellie/db'
import { env } from '@ellie/env/server'
import { Hindsight } from '@ellie/hindsight'
import { createHindsightApp } from '@ellie/hindsight/server'
import { createTusApp, FileStore } from '@ellie/tus'
import { openapi } from '@elysiajs/openapi'
import { staticPlugin } from '@elysiajs/static'
import type { AnyTextAdapter } from '@tanstack/ai'
import {
	type AnthropicChatModel,
	anthropicText,
	createAnthropicChat
} from '@tanstack/ai-anthropic'
import { tryValibotSummary } from '@ellie/schemas'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Elysia } from 'elysia'
import { AgentController } from './agent/controller'
import { MemoryOrchestrator } from './agent/memory-orchestrator'
import { buildGuardrailPolicy } from './agent/guardrail-policy'
import {
	ensureBootstrapInjected,
	isBootstrapInjected
} from './agent/bootstrap'
import { seedWorkspace } from './agent/workspace'
import { RealtimeStore } from './lib/realtime-store'
import { createAgentRoutes } from './routes/agent'
import { createAuthRoutes } from './routes/auth'
import { createChatRoutes } from './routes/chat'
import { errorSchema, type SseState } from './routes/common'
import { createSessionRoutes } from './routes/session'
import { createStatusRoutes } from './routes/status'

const parsedUrl = new URL(env.API_BASE_URL)
const port =
	parsedUrl.port !== ''
		? Number(parsedUrl.port)
		: parsedUrl.protocol === 'https:'
			? 443
			: 80
const { DATA_DIR } = env

function todaySessionId(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `session-${y}-${m}-${d}`
}

const eventStore = new EventStore(
	`${DATA_DIR}/events.db`,
	`${DATA_DIR}/audit`
)
const initialSessionId =
	eventStore.getKv('currentSessionId') ?? todaySessionId()
const store = new RealtimeStore(
	eventStore,
	initialSessionId
)

// Startup recovery: find stale runs and close them via RealtimeStore
// so in-memory #closedRuns set is updated for SSE endpoints
const staleRuns = eventStore.findStaleRuns(5 * 60 * 1000) // 5 min
for (const { sessionId, runId } of staleRuns) {
	try {
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'recovered_after_crash' },
			runId
		)
	} catch (err) {
		console.warn(
			'[server] failed to recover stale run:',
			sessionId,
			runId,
			err
		)
	}
}

// ── Workspace seeding ─────────────────────────────────────────────────────────
const workspaceDir = seedWorkspace(DATA_DIR)
eventStore.markWorkspaceSeededOnce('main')

const STUDIO_PUBLIC = resolve(
	import.meta.dir,
	'../../react/public'
)

const CREDENTIALS_PATH =
	process.env.CREDENTIALS_PATH ??
	resolve(import.meta.dir, '../../../.credentials.json')

// ── Auth resolution ──────────────────────────────────────────────────────────
// Priority: Anthropic (env vars > file) → Groq (env var > file)

async function resolveAnthropicAdapter(): Promise<AnyTextAdapter | null> {
	const model = env.ANTHROPIC_MODEL as AnthropicChatModel

	// ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_BEARER_TOKEN are intentionally read
	// from process.env rather than the validated env schema — they are rarely
	// used override tokens (e.g. for Max plan OAuth) that don't belong in the
	// standard server config schema.
	const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN
	if (oauthToken) return anthropicOAuth(model, oauthToken)

	const bearerToken = process.env.ANTHROPIC_BEARER_TOKEN
	if (bearerToken)
		return createAnthropicChat(model, bearerToken)

	if (env.ANTHROPIC_API_KEY) return anthropicText(model)

	// File fallback
	const cred = await loadAnthropicCredential(
		CREDENTIALS_PATH
	)
	if (!cred) return null

	switch (cred.type) {
		case 'api_key':
			return createAnthropicChat(model, cred.key)
		case 'oauth': {
			// Auto-refresh if expired or expiring within 5 minutes
			const REFRESH_BUFFER_MS = 5 * 60 * 1000
			if (cred.expires - Date.now() < REFRESH_BUFFER_MS) {
				const refreshed = await refreshNormalizedOAuthToken(
					cred.refresh
				)
				if (refreshed) {
					await setAnthropicCredential(
						CREDENTIALS_PATH,
						refreshed
					)
					return anthropicOAuth(model, refreshed.access)
				}
				console.warn(
					'[server] OAuth token refresh failed, using existing token'
				)
			}
			return anthropicOAuth(model, cred.access)
		}
		case 'token':
			return createAnthropicChat(model, cred.token)
		default:
			cred satisfies never
			return null
	}
}

async function resolveGroqAdapter(): Promise<AnyTextAdapter | null> {
	// Env var first
	if (process.env.GROQ_API_KEY) {
		return groqChat(
			'qwen/qwen3-32b',
			process.env.GROQ_API_KEY
		)
	}

	// File fallback
	const cred = await loadGroqCredential(CREDENTIALS_PATH)
	if (cred) {
		return groqChat('qwen/qwen3-32b', cred.key)
	}

	return null
}

async function resolveAdapter(): Promise<AnyTextAdapter | null> {
	return (
		(await resolveAnthropicAdapter()) ??
		(await resolveGroqAdapter())
	)
}

// ── Lazy agent controller ────────────────────────────────────────────────────
// Cached on first access, invalidated when credentials change so routes
// always use the current adapter without requiring a server restart.

let cachedController: AgentController | null | undefined

/**
 * If the OAuth token is expired/expiring, refresh it and hot-swap the
 * adapter on the existing controller — no need to destroy the agent.
 */
async function ensureTokenFresh(): Promise<void> {
	const cred = await loadAnthropicCredential(
		CREDENTIALS_PATH
	)
	if (!cred || cred.type !== 'oauth') return

	const REFRESH_BUFFER_MS = 5 * 60 * 1000
	if (cred.expires - Date.now() < REFRESH_BUFFER_MS) {
		const freshAdapter = await resolveAdapter()
		if (freshAdapter && cachedController) {
			cachedController.updateAdapter(freshAdapter)
		} else {
			// No adapter or no controller yet — fall through to
			// getAgentController() which will create one.
			invalidateAgentCache()
		}
	}
}

async function getAgentController(): Promise<AgentController | null> {
	await ensureTokenFresh()
	if (cachedController !== undefined)
		return cachedController
	const adapter = await resolveAdapter()
	const guardrails = buildGuardrailPolicy(env)

	const memory = new MemoryOrchestrator({
		hindsight,
		eventStore,
		workspaceDir
	})

	cachedController = adapter
		? new AgentController(store, {
				adapter,
				workspaceDir,
				dataDir: DATA_DIR,
				memory,
				agentOptions: guardrails
					? { guardrails }
					: undefined
			})
		: null
	return cachedController
}

/** Call after credentials are written/cleared to force re-resolution. */
function invalidateAgentCache() {
	cachedController = undefined
}

// ── Hindsight (memory) ────────────────────────────────────────────────────
// Single default bank is created lazily on first access.
// Must be initialised before getAgentController() so MemoryOrchestrator
// receives a valid hindsight reference.
const hindsightAdapter = await resolveAdapter()
const hindsight = new Hindsight({
	dbPath: `${DATA_DIR}/hindsight.db`,
	...(hindsightAdapter ? { adapter: hindsightAdapter } : {})
})

// Eagerly resolve once at startup so first request doesn't pay the cost
await getAgentController()

// ── Tus uploads ───────────────────────────────────────────────────────────
const uploadStore = new FileStore({
	directory: `${DATA_DIR}/uploads`,
	expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000 // 24h
})

const sseState: SseState = {
	activeClients: 0
}

// ── Session rotation cron ─────────────────────────────────────────────────────
// Kept outside the Elysia app chain so the croner type doesn't leak into the
// exported App type (which Eden uses for type-safe client generation).
import { Cron } from 'croner'
new Cron('0 0 * * *', () => {
	store.rotateSession(todaySessionId())
})

export const app = new Elysia()
	.use(
		openapi({
			documentation: {
				info: {
					title: 'Ellie API',
					version: '1.0.0'
				},
				tags: [
					{ name: 'Status', description: 'Server status' },
					{
						name: 'Chat',
						description: 'Chat sessions and messages'
					},
					{
						name: 'Agent',
						description: 'Agent management'
					},
					{
						name: 'Auth',
						description: 'Anthropic credential management'
					},
					{
						name: 'Session',
						description: 'Session management'
					},
					{
						name: 'Uploads',
						description: 'Tus upload management'
					}
				]
			},
			mapJsonSchema: { valibot: toJsonSchema }
		})
	)
	.use(
		createStatusRoutes(
			() => sseState.activeClients,
			() => !isBootstrapInjected(eventStore)
		)
	)
	.use(createSessionRoutes(store))
	.use(
		createChatRoutes(
			store,
			sseState,
			getAgentController,
			sessionId =>
				ensureBootstrapInjected({
					sessionId,
					store,
					eventStore,
					workspaceDir
				})
		)
	)
	.use(
		createAgentRoutes(store, getAgentController, sseState)
	)
	.use(
		createAuthRoutes(CREDENTIALS_PATH, invalidateAgentCache)
	)
	.use(
		createTusApp({
			datastore: uploadStore,
			relativeLocation: true,
			maxSize: 500 * 1024 * 1024 // 500 MB
		})
	)
	.use(createHindsightApp(hindsight))
	.get('/', ({ redirect }) => redirect('/app'))
	.use(
		await staticPlugin({
			assets: STUDIO_PUBLIC,
			prefix: `/app`,
			indexHTML: true
		})
	)
	.all(
		`/*`,
		({ set }) => {
			set.status = 404
			return { error: `Not Found` }
		},
		{
			detail: { hide: true },
			response: {
				404: errorSchema
			}
		}
	)
	.onError(({ code, error, set, request }) => {
		if (code === `VALIDATION`) {
			set.status = 400

			if (
				request.headers.get(`x-error-detail`) === `summary`
			) {
				const summary = tryValibotSummary(
					error.validator,
					error.value
				)
				if (summary) return { error: summary }
			}

			return {
				error: error.message
			}
		}

		const message =
			error instanceof Error ? error.message : String(error)
		const lower = message.toLowerCase()
		if (lower.includes(`not found`)) set.status = 404
		if (
			lower.includes(`missing`) ||
			lower.includes(`empty`) ||
			lower.includes(`invalid`)
		) {
			set.status = 400
		}
		if (set.status === 200) set.status = 500

		return {
			error: message
		}
	})

export type App = typeof app

app.listen(port)
