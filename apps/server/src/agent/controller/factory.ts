import { loadAnthropicCredential } from '@ellie/ai/credentials'
import type { EventStore } from '@ellie/db'
import type { Hindsight } from '@ellie/hindsight'
import type { TraceRecorder, BlobSink } from '@ellie/trace'
import { AgentController } from './controller'
import { MemoryOrchestrator } from '../memory-orchestrator'
import { buildGuardrailPolicy } from '../guardrail-policy'
import type { RealtimeStore } from '../../lib/realtime-store'
import { resolveAgentAdapter } from '../../adapters'
import type { ServerEnv } from '@ellie/env/server'

interface ControllerFactoryDeps {
	store: RealtimeStore
	eventStore: EventStore
	hindsight: Hindsight
	credentialsPath: string
	workspaceDir: string
	dataDir: string
	env: ServerEnv
	traceRecorder?: TraceRecorder
	blobSink?: BlobSink
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000

export class AgentControllerFactory {
	private cached: AgentController | null | undefined
	private readonly deps: ControllerFactoryDeps

	constructor(deps: ControllerFactoryDeps) {
		this.deps = deps
	}

	async get(): Promise<AgentController | null> {
		await this.ensureTokenFresh()
		if (this.cached !== undefined) return this.cached

		const {
			store,
			eventStore,
			hindsight,
			credentialsPath,
			workspaceDir,
			dataDir,
			env
		} = this.deps
		const adapter =
			await resolveAgentAdapter(credentialsPath)
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

		this.cached = adapter
			? new AgentController(store, {
					adapter,
					workspaceDir,
					dataDir,
					memory,
					agentOptions: guardrails
						? { guardrails }
						: undefined,
					traceRecorder: this.deps.traceRecorder,
					blobSink: this.deps.blobSink
				})
			: null
		return this.cached
	}

	invalidate(): void {
		this.cached = undefined
	}

	private async ensureTokenFresh(): Promise<void> {
		const cred = await loadAnthropicCredential(
			this.deps.credentialsPath
		)
		if (!cred || cred.type !== 'oauth') return

		if (cred.expires - Date.now() < REFRESH_BUFFER_MS) {
			const freshAdapter = await resolveAgentAdapter(
				this.deps.credentialsPath
			)
			if (freshAdapter && this.cached) {
				this.cached.updateAdapter(freshAdapter)
			} else {
				this.cached = undefined
			}
		}
	}
}
