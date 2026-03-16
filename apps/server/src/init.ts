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
import {
	createAssistantAgentDefinition,
	seedWorkspace
} from '@ellie/assistant-agent'
import { createCodingAgentDefinition } from '@ellie/coding-agent'
import {
	AgentDefinitionRegistry,
	BranchRuntimeRegistry,
	type BranchRuntimeHost
} from './agent/runtime'
import {
	ensureBootstrapInjected,
	isBootstrapInjected
} from './agent/bootstrap'
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
	getRuntimeHost: (
		branchId: string
	) => Promise<BranchRuntimeHost | null>
	invalidateRuntimeCache: () => void
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

function initStores(dataDir: string): StoresContext {
	const eventStore = new EventStore(`${dataDir}/events.db`)
	const store = new RealtimeStore(eventStore)

	const today = todayDayKey()
	const savedDayKey = eventStore.getKv(
		'assistant.defaultDayKey'
	)
	const existing = store.getDefaultAssistantThread()

	if (!existing || savedDayKey !== today) {
		store.rotateAssistantThread('assistant', 'main', today)
	}

	const recovered = eventStore.recoverStaleStreamingEvents()
	if (recovered.tools || recovered.messages) {
		console.log(
			`[server] recovered stale streaming events: ${recovered.tools} tool(s), ${recovered.messages} message(s)`
		)
	}

	return { eventStore, store }
}

function recoverStaleRuns(
	eventStore: EventStore,
	store: RealtimeStore
): void {
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

	const { dir: STUDIO_PUBLIC } = resolveStudioPublic({
		candidates: [
			resolve(import.meta.dir, 'web'),
			resolve(import.meta.dir, '../../web/dist'),
			resolve(import.meta.dir, '../public')
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
	getRuntimeHost: (
		branchId: string
	) => Promise<BranchRuntimeHost | null>
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
			getBranchRuntimeHost: deps.getRuntimeHost,
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

	// Build definition registry
	const definitionRegistry = new AgentDefinitionRegistry()
	definitionRegistry.register(
		createAssistantAgentDefinition({
			hindsight,
			eventStore
		})
	)
	definitionRegistry.register(createCodingAgentDefinition())

	const runtimeRegistry = new BranchRuntimeRegistry({
		store,
		eventStore,
		credentialsPath: CREDENTIALS_PATH,
		workspaceDir,
		dataDir: DATA_DIR,
		env,
		traceRecorder,
		blobSink,
		definitionRegistry
	})

	// Eagerly resolve adapter at startup
	// (no branch needed yet — adapter is shared)

	const sseState: SseState = { activeClients: 0 }

	new Cron('0 0 * * *', () => {
		store.rotateAssistantThread(
			'assistant',
			'main',
			todayDayKey()
		)
	})

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
			getRuntimeHost: (branchId: string) =>
				runtimeRegistry.get(branchId),
			ensureBootstrap,
			uploadStore
		}
	)

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

	const currentAssistant = store.getDefaultAssistantThread()
	if (currentAssistant) {
		deliveryRegistry.watchBranch(currentAssistant.branchId)
		ttsPostProcessor.watchBranch(currentAssistant.branchId)
	}
	store.subscribeToAssistantChange(event => {
		deliveryRegistry.watchBranch(event.newBranchId)
		ttsPostProcessor.watchBranch(event.newBranchId)
	})

	deliveryRegistry.setTtsPostProcessor(ttsPostProcessor)

	try {
		await channelManager.waitForReady()
	} catch (err) {
		console.warn('[server] Channel readiness timeout:', err)
	}
	recoverStaleRuns(eventStore, store)
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
		getRuntimeHost: (branchId: string) =>
			runtimeRegistry.get(branchId),
		invalidateRuntimeCache: () =>
			runtimeRegistry.invalidate(),
		ensureBootstrap,
		isBootstrapInjected: () =>
			isBootstrapInjected(eventStore),
		channelManager
	}
}
