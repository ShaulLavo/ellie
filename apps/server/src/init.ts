import { resolve } from 'node:path'
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
import { resolveStudioPublic } from './lib/studio-public'
import { startStt } from './lib/stt'
import { resolveGroqAdapter } from './adapters'
import type { SseState } from './routes/common'
import { initTraceRuntime } from './trace/init-trace'
import {
	ChannelManager,
	ChannelDeliveryRegistry,
	type ChannelProvider
} from './channels/core'
import { WhatsAppProvider } from './channels/providers/whatsapp'
import { TtsPostProcessor } from './lib/tts-post-processor'

interface ServerContext {
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
	ensureBootstrap: (branchId: string, runId: string) => void
	isBootstrapInjected: () => boolean
	channelManager: ChannelManager
}

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

export function todayDayKey(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

/**
 * Creates EventStore + RealtimeStore and recovers stale streaming
 * state (tools stuck as 'running', messages stuck as 'streaming').
 *
 * NOTE: Stale run recovery (appending run_closed events) is deferred
 * to recoverStaleRuns() so it runs after the delivery registry is
 * watching — enabling channel delivery for crash-recovered runs.
 */
function initStores(dataDir: string): StoresContext {
	const eventStore = new EventStore(`${dataDir}/events.db`)
	const store = new RealtimeStore(eventStore)

	// Ensure default assistant thread exists for today
	const today = todayDayKey()
	const savedDayKey = eventStore.getKv(
		'assistant.defaultDayKey'
	)
	const existing = store.getDefaultAssistantThread()

	if (!existing || savedDayKey !== today) {
		// Day changed or no thread — rotate (marks old thread view_only)
		store.rotateAssistantThread('assistant', 'main', today)
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
 * Close runs that were still open when the server last exited.
 * Called AFTER the delivery registry is watching so that the
 * emitted run_closed events trigger channel delivery.
 */
function recoverStaleRuns(
	eventStore: EventStore,
	store: RealtimeStore
): void {
	// On startup there is no live worker that can continue an open run,
	// so every unclosed run is stale immediately.
	const staleRuns = eventStore.findStaleRuns(0)
	for (const { branchId, runId } of staleRuns) {
		try {
			store.appendEvent(
				branchId,
				'run_closed',
				{ reason: 'recovered_after_crash' },
				runId
			)
		} catch (err) {
			console.warn(
				'[server] failed to recover stale run:',
				branchId,
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

interface ServerConfig {
	port: number
	CREDENTIALS_PATH: string
	STUDIO_PUBLIC: string
}

function resolveConfig(): ServerConfig {
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

	const isDev = process.env.NODE_ENV !== 'production'
	const { dir: STUDIO_PUBLIC } = resolveStudioPublic({
		candidates: isDev
			? [
					// Dev: always use live source (Bun bundles on the fly)
					resolve(import.meta.dir, '../../web/public')
				]
			: [
					// Prod bundle layout: dist/release/web
					resolve(import.meta.dir, 'web'),
					// Prod source layout: apps/web/dist (pre-built)
					resolve(import.meta.dir, '../../web/dist')
				]
	})

	return { port, CREDENTIALS_PATH, STUDIO_PUBLIC }
}

interface ChannelsContext {
	channelManager: ChannelManager
	deliveryRegistry: ChannelDeliveryRegistry
}

function initChannels(deps: {
	store: RealtimeStore
	dataDir: string
	credentialsPath: string
	getAgentController: () => Promise<AgentController | null>
	ensureBootstrap: (branchId: string, runId: string) => void
	uploadStore: FileStore
}): ChannelsContext {
	const deliveryRegistry: ChannelDeliveryRegistry =
		new ChannelDeliveryRegistry({
			store: deps.store,
			getProvider: (
				id: string
			): ChannelProvider | undefined =>
				channelManager.getProvider(id),
			dataDir: deps.dataDir,
			credentialsPath: deps.credentialsPath,
			getTtsConfig: () => ({ mode: 'tagged' })
		})

	const channelManager: ChannelManager = new ChannelManager(
		{
			dataDir: deps.dataDir,
			store: deps.store,
			getAgentController: deps.getAgentController,
			ensureBootstrap: deps.ensureBootstrap,
			deliveryRegistry,
			uploadStore: deps.uploadStore
		}
	)

	channelManager.register(new WhatsAppProvider())

	return { channelManager, deliveryRegistry }
}

export async function init(): Promise<ServerContext> {
	const { DATA_DIR } = env
	const { port, CREDENTIALS_PATH, STUDIO_PUBLIC } =
		resolveConfig()

	const { eventStore, store } = initStores(DATA_DIR)

	const workspaceDir = seedWorkspace(DATA_DIR)
	eventStore.markWorkspaceSeededOnce('main')

	await startTei()

	await startStt()

	const { hindsight } = await initHindsight(
		DATA_DIR,
		CREDENTIALS_PATH
	)

	const { uploadStore } = initUploads(DATA_DIR)

	const { recorder: traceRecorder, blobSink } =
		initTraceRuntime(DATA_DIR, uploadStore)

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

	new Cron('0 0 * * *', () => {
		store.rotateAssistantThread(
			'assistant',
			'main',
			todayDayKey()
		)
	})

	// TODO: speech artifact TTL cleanup (expire stale drafts, delete blobs)

	const ensureBootstrap = (
		branchId: string,
		runId: string
	) =>
		ensureBootstrapInjected({
			branchId,
			runId,
			store,
			eventStore,
			workspaceDir
		})

	const { channelManager, deliveryRegistry } = initChannels(
		{
			store,
			dataDir: DATA_DIR,
			credentialsPath: CREDENTIALS_PATH,
			getAgentController: () => controllerFactory.get(),
			ensureBootstrap,
			uploadStore
		}
	)

	// Boot channels (awaited so providers are ready for recovery)
	try {
		await channelManager.bootAll()
	} catch (err) {
		console.error('[server] Channel boot error:', err)
	}

	const ttsPostProcessor = new TtsPostProcessor({
		store,
		blobSink,
		credentialsPath: CREDENTIALS_PATH,
		dataDir: DATA_DIR
	})

	// Watch current branch for channel delivery
	const currentAssistant = store.getDefaultAssistantThread()
	if (currentAssistant) {
		deliveryRegistry.watchBranch(currentAssistant.branchId)
		ttsPostProcessor.watchBranch(currentAssistant.branchId)
	}
	// Re-subscribe on daily thread rotation
	store.subscribeToAssistantChange(event => {
		deliveryRegistry.watchBranch(event.newBranchId)
		ttsPostProcessor.watchBranch(event.newBranchId)
	})

	// Let delivery registry await TtsPostProcessor audio instead of racing
	deliveryRegistry.setTtsPostProcessor(ttsPostProcessor)

	// Wait for channel sockets to be fully connected before delivering
	try {
		await channelManager.waitForReady()
	} catch (err) {
		console.warn('[server] Channel readiness timeout:', err)
	}
	// Phase 1: Close stale runs — run_closed events trigger delivery
	// via the subscription above (handles crash-during-agent-run)
	recoverStaleRuns(eventStore, store)
	// Phase 2: Re-deliver runs that closed before the crash but
	// whose delivery never completed (handles crash-during-delivery)
	deliveryRegistry
		.recoverUndelivered(eventStore)
		.catch((err: unknown) => {
			console.error(
				'[server] Delivery recovery error:',
				err
			)
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
