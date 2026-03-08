import { resolve } from 'node:path'
import { rmSync, existsSync } from 'node:fs'
import { EventStore } from '@ellie/db'
import { env } from '@ellie/env/server'
import { Hindsight } from '@ellie/hindsight'
import type {
	TraceRecorder,
	TusBlobSink
} from '@ellie/trace'
import { FileStore, SqliteKvStore } from '@ellie/tus'
import { Cron } from 'croner'
import type { AgentController } from './agent/controller'
import { AgentControllerFactory } from './agent/controller'
import {
	ensureBootstrapInjected,
	isBootstrapInjected
} from './agent/bootstrap'
import { seedWorkspace } from './agent/workspace'
import { RealtimeStore } from './lib/realtime-store'
import { startTei } from './lib/tei'
import { startStt } from './lib/stt'
import { resolveGroqAdapter } from './adapters'
import type { SseState } from './routes/common'
import { initTraceRuntime } from './trace/init-trace'
import {
	ChannelManager,
	ChannelDeliveryRegistry
} from './channels/core'
import { WhatsAppProvider } from './channels/providers/whatsapp'

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
	traceRecorder: TraceRecorder
	blobSink: TusBlobSink
	sseState: SseState
	sttBaseUrl: string
	getAgentController: () => Promise<AgentController | null>
	invalidateAgentCache: () => void
	ensureBootstrap: (sessionId: string) => void
	isBootstrapInjected: () => boolean
	channelManager: ChannelManager
}

// ── Phase sub-context types ──────────────────────────────────────────────

interface StoresContext {
	eventStore: EventStore
	store: RealtimeStore
}

interface HindsightContext {
	hindsight: Hindsight
}

interface UploadsContext {
	uploadStore: FileStore
}

// ── Helpers ──────────────────────────────────────────────────────────────

function todaySessionId(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `session-${y}-${m}-${d}`
}

/**
 * Delete legacy data directories that are no longer used.
 * Safe to call on every startup — skips directories that don't exist.
 */
function cleanupLegacyData(dataDir: string): void {
	const legacyDirs = [
		'audit',
		'tool-overflow',
		'repl-artifacts'
	]
	for (const dir of legacyDirs) {
		const fullPath = `${dataDir}/${dir}`
		if (existsSync(fullPath)) {
			rmSync(fullPath, { recursive: true, force: true })
			console.log(
				`[server] removed legacy directory: ${fullPath}`
			)
		}
	}
}

/**
 * Creates EventStore + RealtimeStore and recovers any stale runs
 * left over from a previous crash.
 */
function initStores(dataDir: string): StoresContext {
	const eventStore = new EventStore(`${dataDir}/events.db`)
	const initialSessionId =
		eventStore.getKv('currentSessionId') ?? todaySessionId()
	const store = new RealtimeStore(
		eventStore,
		initialSessionId
	)

	// Startup recovery — close runs that were still open when the
	// server last exited.
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

	// Recover stale streaming events (tools stuck as 'running',
	// messages stuck as 'streaming') from a previous crash.
	const recovered = eventStore.recoverStaleStreamingEvents()
	if (recovered.tools || recovered.messages) {
		console.log(
			`[server] recovered stale streaming events: ${recovered.tools} tool(s), ${recovered.messages} message(s)`
		)
	}

	return { eventStore, store }
}

/**
 * Resolves the LLM adapter and creates the Hindsight memory system.
 */
async function initHindsight(
	dataDir: string,
	credentialsPath: string
): Promise<HindsightContext> {
	const hindsightAdapter =
		await resolveGroqAdapter(credentialsPath)
	const hindsight = new Hindsight({
		dbPath: `${dataDir}/hindsight.db`,
		...(hindsightAdapter
			? { adapter: hindsightAdapter }
			: {})
	})

	return { hindsight }
}

/**
 * Creates the tus FileStore backed by a SQLite config store.
 */
function initUploads(dataDir: string): UploadsContext {
	const uploadStore = new FileStore({
		directory: `${dataDir}/uploads`,
		configstore: new SqliteKvStore(`${dataDir}/uploads.db`)
	})

	return { uploadStore }
}

// ── Main init ────────────────────────────────────────────────────────────

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
		'../../web/public'
	)

	// ── Legacy cleanup ───────────────────────────────────────────────────
	cleanupLegacyData(DATA_DIR)

	// ── Stores ────────────────────────────────────────────────────────────
	const { eventStore, store } = initStores(DATA_DIR)

	// ── Workspace seeding ─────────────────────────────────────────────────
	const workspaceDir = seedWorkspace(DATA_DIR)
	eventStore.markWorkspaceSeededOnce('main')

	// ── TEI (embeddings & reranking) ──────────────────────────────────────
	await startTei()

	// ── STT (speech-to-text) ──────────────────────────────────────────────
	await startStt()

	// ── Hindsight (memory) ────────────────────────────────────────────────
	const { hindsight } = await initHindsight(
		DATA_DIR,
		CREDENTIALS_PATH
	)

	// ── Tus uploads ───────────────────────────────────────────────────────
	const { uploadStore } = initUploads(DATA_DIR)

	// ── Trace runtime ─────────────────────────────────────────────────────
	const { recorder: traceRecorder, blobSink } =
		initTraceRuntime(DATA_DIR, uploadStore)

	// ── Agent controller (lazy-init + token refresh) ─────────────────────
	const controllerFactory = new AgentControllerFactory({
		store,
		eventStore,
		hindsight,
		credentialsPath: CREDENTIALS_PATH,
		workspaceDir,
		dataDir: DATA_DIR,
		env,
		traceRecorder,
		blobSink
	})

	// Eagerly resolve once at startup
	await controllerFactory.get()

	const sseState: SseState = { activeClients: 0 }

	// ── Session rotation cron ─────────────────────────────────────────────
	new Cron('0 0 * * *', () => {
		store.rotateSession(todaySessionId())
	})

	// TODO: speech artifact TTL cleanup (expire stale drafts, delete blobs)

	// ── Bootstrap helper ──────────────────────────────────────────────────
	const ensureBootstrap = (sessionId: string) =>
		ensureBootstrapInjected({
			sessionId,
			store,
			eventStore,
			workspaceDir
		})

	// ── Channels ─────────────────────────────────────────────────────────
	const deliveryRegistry = new ChannelDeliveryRegistry({
		store,
		getProvider: id => channelManager.getProvider(id)
	})

	const channelManager = new ChannelManager({
		dataDir: DATA_DIR,
		store,
		getAgentController: () => controllerFactory.get(),
		ensureBootstrap,
		deliveryRegistry
	})

	channelManager.register(new WhatsAppProvider())

	// Boot channels with saved settings (non-blocking)
	channelManager.bootAll().catch(err => {
		console.error('[server] Channel boot error:', err)
	})

	// Watch current session for channel delivery
	deliveryRegistry.watchSession(
		store.getCurrentSessionId()
	)
	// Re-subscribe on daily session rotation
	store.subscribeToRotation(event => {
		deliveryRegistry.watchSession(event.newSessionId)
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
		traceRecorder,
		blobSink,
		sseState,
		sttBaseUrl: env.STT_BASE_URL,
		getAgentController: () => controllerFactory.get(),
		invalidateAgentCache: () =>
			controllerFactory.invalidate(),
		ensureBootstrap,
		isBootstrapInjected: () =>
			isBootstrapInjected(eventStore),
		channelManager
	}
}
