import { resolve } from 'node:path'
import { loadAnthropicCredential } from '@ellie/ai/credentials'
import { EventStore } from '@ellie/db'
import { env } from '@ellie/env/server'
import { Hindsight } from '@ellie/hindsight'
import { FileStore } from '@ellie/tus'
import { Cron } from 'croner'
import { AgentController } from './agent/controller'
import { MemoryOrchestrator } from './agent/memory-orchestrator'
import { buildGuardrailPolicy } from './agent/guardrail-policy'
import {
	ensureBootstrapInjected,
	isBootstrapInjected
} from './agent/bootstrap'
import { seedWorkspace } from './agent/workspace'
import { RealtimeStore } from './lib/realtime-store'
import { startTei } from './lib/tei'
import {
	resolveAgentAdapter,
	resolveGroqAdapter
} from './adapters'
import type { SseState } from './routes/common'

export interface ServerContext {
	port: number
	DATA_DIR: string
	CREDENTIALS_PATH: string
	STUDIO_PUBLIC: string
	workspaceDir: string
	eventStore: EventStore
	store: RealtimeStore
	hindsight: Hindsight
	uploadStore: FileStore
	sseState: SseState
	getAgentController: () => Promise<AgentController | null>
	invalidateAgentCache: () => void
	ensureBootstrap: (sessionId: string) => void
	isBootstrapInjected: () => boolean
}

function todaySessionId(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `session-${y}-${m}-${d}`
}

export async function init(): Promise<ServerContext> {
	const { DATA_DIR } = env

	// ── Config ────────────────────────────────────────────────────────────
	const parsedUrl = new URL(env.API_BASE_URL)
	const port =
		parsedUrl.port !== ''
			? Number(parsedUrl.port)
			: parsedUrl.protocol === 'https:'
				? 443
				: 80

	const CREDENTIALS_PATH =
		process.env.CREDENTIALS_PATH ??
		resolve(import.meta.dir, '../../../.credentials.json')

	const STUDIO_PUBLIC = resolve(
		import.meta.dir,
		'../../react/public'
	)

	// ── Stores ────────────────────────────────────────────────────────────
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

	// ── Startup recovery ──────────────────────────────────────────────────
	const staleRuns = eventStore.findStaleRuns(5 * 60 * 1000)
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

	// ── Workspace seeding ─────────────────────────────────────────────────
	const workspaceDir = seedWorkspace(DATA_DIR)
	eventStore.markWorkspaceSeededOnce('main')

	// ── TEI (embeddings & reranking) ──────────────────────────────────────
	await startTei()

	// ── Hindsight (memory) ────────────────────────────────────────────────
	const hindsightAdapter = await resolveGroqAdapter(
		CREDENTIALS_PATH
	)
	const hindsight = new Hindsight({
		dbPath: `${DATA_DIR}/hindsight.db`,
		...(hindsightAdapter
			? { adapter: hindsightAdapter }
			: {})
	})

	// ── Lazy agent controller ─────────────────────────────────────────────
	let cachedController: AgentController | null | undefined

	async function ensureTokenFresh(): Promise<void> {
		const cred = await loadAnthropicCredential(
			CREDENTIALS_PATH
		)
		if (!cred || cred.type !== 'oauth') return

		const REFRESH_BUFFER_MS = 5 * 60 * 1000
		if (cred.expires - Date.now() < REFRESH_BUFFER_MS) {
			const freshAdapter = await resolveAgentAdapter(
				CREDENTIALS_PATH
			)
			if (freshAdapter && cachedController) {
				cachedController.updateAdapter(freshAdapter)
			} else {
				cachedController = undefined
			}
		}
	}

	async function getAgentController(): Promise<AgentController | null> {
		await ensureTokenFresh()
		if (cachedController !== undefined)
			return cachedController
		const adapter = await resolveAgentAdapter(
			CREDENTIALS_PATH
		)
		const guardrails = buildGuardrailPolicy(env)

		const memory = new MemoryOrchestrator({
			hindsight,
			eventStore,
			workspaceDir,
			onTrace: entry => {
				store.trace({
					sessionId: store.getCurrentSessionId(),
					type: entry.type,
					payload: entry.payload
				})
			}
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

	function invalidateAgentCache() {
		cachedController = undefined
	}

	// Eagerly resolve once at startup
	await getAgentController()

	// ── Tus uploads ───────────────────────────────────────────────────────
	const uploadStore = new FileStore({
		directory: `${DATA_DIR}/uploads`,
		expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000
	})

	const sseState: SseState = { activeClients: 0 }

	// ── Session rotation cron ─────────────────────────────────────────────
	new Cron('0 0 * * *', () => {
		store.rotateSession(todaySessionId())
	})

	// ── Bootstrap helper ──────────────────────────────────────────────────
	const ensureBootstrap = (sessionId: string) =>
		ensureBootstrapInjected({
			sessionId,
			store,
			eventStore,
			workspaceDir
		})

	return {
		port,
		DATA_DIR,
		CREDENTIALS_PATH,
		STUDIO_PUBLIC,
		workspaceDir,
		eventStore,
		store,
		hindsight,
		uploadStore,
		sseState,
		getAgentController,
		invalidateAgentCache,
		ensureBootstrap,
		isBootstrapInjected: () =>
			isBootstrapInjected(eventStore)
	}
}
