import { resolve } from 'node:path'
import { openapi } from '@elysiajs/openapi'
import { toJsonSchema } from '@valibot/to-json-schema'
import { staticPlugin } from '@elysiajs/static'
import { EventStore } from '@ellie/db'
import { env } from '@ellie/env/server'
import {
	anthropicText,
	createAnthropicChat,
	type AnthropicChatModel
} from '@tanstack/ai-anthropic'
import type { AnyTextAdapter } from '@tanstack/ai'
import { loadAnthropicCredential } from '@ellie/ai/credentials'
import { anthropicOAuth } from '@ellie/ai/anthropic-oauth'
import { Elysia } from 'elysia'
import { AgentManager } from './agent/manager'
import { AgentWatcher } from './agent/watcher'
import { RealtimeStore } from './lib/realtime-store'
import { errorSchema, type SseState } from './routes/common'
import { createAgentRoutes } from './routes/agent'
import { createChatRoutes } from './routes/chat'
import { createStatusRoutes } from './routes/status'
import { createAuthRoutes } from './routes/auth'

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

// ── Auth resolution: ANTHROPIC_OAUTH_TOKEN > BEARER_TOKEN > API_KEY > file ──
async function resolveAdapter(): Promise<AnyTextAdapter | null> {
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
		case 'oauth':
			return anthropicOAuth(model, cred.access)
		case 'token':
			return createAnthropicChat(model, cred.token)
		default:
			cred satisfies never
			return null
	}
}

const resolvedAdapter = await resolveAdapter()

const agentManager: AgentManager | null = resolvedAdapter
	? new AgentManager(store, {
			adapter: resolvedAdapter,
			systemPrompt: 'You are a helpful assistant.'
		})
	: null

const agentWatcher = agentManager
	? new AgentWatcher(store, agentManager)
	: null

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
					}
				]
			},
			mapJsonSchema: { valibot: toJsonSchema }
		})
	)
	.use(createStatusRoutes(() => sseState.activeClients))
	.use(createChatRoutes(store, sseState, agentWatcher))
	.use(createAgentRoutes(store, agentManager, sseState))
	.use(createAuthRoutes(CREDENTIALS_PATH))
	.all(
		`/api/*`,
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
	.all(
		`/chat/*`,
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
	.all(
		`/agent/*`,
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
	.use(
		await staticPlugin({
			assets: STUDIO_PUBLIC,
			prefix: `/`,
			indexHTML: true
		})
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
