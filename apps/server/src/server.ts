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
import { openapi } from '@elysiajs/openapi'
import { staticPlugin } from '@elysiajs/static'
import type { AnyTextAdapter } from '@tanstack/ai'
import {
	type AnthropicChatModel,
	anthropicText,
	createAnthropicChat
} from '@tanstack/ai-anthropic'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Elysia } from 'elysia'
import { AgentManager } from './agent/manager'
import { AgentWatcher } from './agent/watcher'
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

console.log(`[server] DATA_DIR=${DATA_DIR}`)

const eventStore = new EventStore(
	`${DATA_DIR}/events.db`,
	`${DATA_DIR}/audit`
)
const store = new RealtimeStore(eventStore)

// Startup recovery: find stale runs and close them via RealtimeStore
// so in-memory #closedRuns set is updated for SSE endpoints
const staleRuns = eventStore.findStaleRuns(5 * 60 * 1000) // 5 min
for (const { sessionId, runId } of staleRuns) {
	console.log(
		`[server] recovering stale run: session=${sessionId} run=${runId}`
	)
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
if (staleRuns.length > 0) {
	console.log(
		`[server] recovered ${staleRuns.length} stale run(s)`
	)
}

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
				console.log(
					'[server] OAuth token expired or expiring soon, refreshing…'
				)
				const refreshed = await refreshNormalizedOAuthToken(
					cred.refresh
				)
				if (refreshed) {
					await setAnthropicCredential(
						CREDENTIALS_PATH,
						refreshed
					)
					console.log(
						'[server] OAuth token refreshed successfully'
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

// ── Lazy agent manager / watcher ────────────────────────────────────────────
// Cached on first access, invalidated when credentials change so routes
// always use the current adapter without requiring a server restart.

let cachedAgentManager: AgentManager | null | undefined
let cachedAgentWatcher: AgentWatcher | null | undefined

/**
 * Check if file-based OAuth token is expired/expiring and invalidate cache
 * so resolveAdapter() will run the refresh flow on next access.
 */
async function ensureTokenFresh(): Promise<void> {
	const cred = await loadAnthropicCredential(
		CREDENTIALS_PATH
	)
	if (!cred || cred.type !== 'oauth') return

	const REFRESH_BUFFER_MS = 5 * 60 * 1000
	if (cred.expires - Date.now() < REFRESH_BUFFER_MS) {
		invalidateAgentCache()
	}
}

async function getAgentManager(): Promise<AgentManager | null> {
	await ensureTokenFresh()
	if (cachedAgentManager !== undefined)
		return cachedAgentManager
	const adapter = await resolveAdapter()
	cachedAgentManager = adapter
		? new AgentManager(store, {
				adapter,
				systemPrompt: 'You are a helpful assistant.'
			})
		: null
	return cachedAgentManager
}

async function getAgentWatcher(): Promise<AgentWatcher | null> {
	const mgr = await getAgentManager()
	if (cachedAgentWatcher !== undefined)
		return cachedAgentWatcher
	cachedAgentWatcher = mgr
		? new AgentWatcher(store, mgr)
		: null
	return cachedAgentWatcher
}

/** Call after credentials are written/cleared to force re-resolution. */
function invalidateAgentCache() {
	cachedAgentManager = undefined
	cachedAgentWatcher = undefined
}

// Eagerly resolve once at startup so first request doesn't pay the cost
await getAgentManager()

// ── Hindsight (memory) ────────────────────────────────────────────────────
// Single default bank is created lazily on first access.
const hindsightAdapter = await resolveAdapter()
const hindsight = new Hindsight({
	dbPath: `${DATA_DIR}/hindsight.db`,
	...(hindsightAdapter ? { adapter: hindsightAdapter } : {})
})

const sseState: SseState = {
	activeClients: 0
}

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
					}
				]
			},
			mapJsonSchema: { valibot: toJsonSchema }
		})
	)
	.use(createStatusRoutes(() => sseState.activeClients))
	.use(createSessionRoutes(store))
	.use(createChatRoutes(store, sseState, getAgentWatcher))
	.use(createAgentRoutes(store, getAgentManager, sseState))
	.use(
		createAuthRoutes(CREDENTIALS_PATH, invalidateAgentCache)
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
	.onError(({ code, error, set }) => {
		if (code === `VALIDATION`) {
			set.status = 400
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

console.log(
	`[server] listening on http://localhost:${port}`
)
