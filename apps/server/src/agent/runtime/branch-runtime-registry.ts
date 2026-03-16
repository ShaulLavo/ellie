/**
 * BranchRuntimeRegistry — caches BranchRuntimeHost per branchId,
 * resolves the branch's thread, looks up thread.agentType,
 * resolves the matching AgentDefinition, and evicts idle runtimes.
 */

import { loadAnthropicCredential } from '@ellie/ai/credentials'
import type { AgentHostServices } from '@ellie/agent'
import type { EventStore } from '@ellie/db'
import type {
	TraceRecorder,
	BlobSink,
	TraceScope
} from '@ellie/trace'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { RealtimeStore } from '../../lib/realtime-store'
import { resolveAgentAdapter } from '../../adapters'
import { buildGuardrailPolicy } from '../guardrail-policy'
import type { ServerEnv } from '@ellie/env/server'
import { AgentDefinitionRegistry } from './definition-registry'
import { BranchRuntimeHost } from './branch-runtime-host'

interface BranchRuntimeRegistryDeps {
	store: RealtimeStore
	eventStore: EventStore
	credentialsPath: string
	workspaceDir: string
	dataDir: string
	env: ServerEnv
	traceRecorder?: TraceRecorder
	blobSink?: BlobSink
	definitionRegistry: AgentDefinitionRegistry
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000

export class BranchRuntimeRegistry {
	private readonly hosts = new Map<
		string,
		BranchRuntimeHost
	>()
	private readonly deps: BranchRuntimeRegistryDeps
	private adapter: AnyTextAdapter | null = null
	private adapterResolved = false
	private adapterInflight: Promise<AnyTextAdapter | null> | null =
		null

	constructor(deps: BranchRuntimeRegistryDeps) {
		this.deps = deps
	}

	async get(
		branchId: string
	): Promise<BranchRuntimeHost | null> {
		const adapter = await this.resolveAdapter()
		if (!adapter) return null

		const existing = this.hosts.get(branchId)
		if (existing) return existing

		return this.createHost(branchId, adapter)
	}

	invalidate(): void {
		this.hosts.clear()
		this.adapterResolved = false
		this.adapter = null
	}

	private createHost(
		branchId: string,
		adapter: AnyTextAdapter
	): BranchRuntimeHost {
		const {
			store,
			workspaceDir,
			dataDir,
			env,
			definitionRegistry
		} = this.deps

		// Resolve agentType from thread
		const branch = store.getBranch(branchId)
		const threadId = branch?.threadId
		const thread = threadId
			? store.getThread(threadId)
			: undefined
		const agentType = thread?.agentType ?? 'assistant'

		const definition = definitionRegistry.require(agentType)
		const guardrails = buildGuardrailPolicy(env)

		// Mutable trace scope ref — the host updates this,
		// tools read it via services.getTraceScope
		const traceScopeRef = {
			current: undefined as TraceScope | undefined
		}

		const services: AgentHostServices = {
			workspaceDir,
			dataDir,
			credentialsPath: this.deps.credentialsPath,
			loadHistory: (bid: string) =>
				store.listAgentMessages(bid),
			getThreadId: (bid: string) =>
				store.getBranch(bid)?.threadId,
			traceRecorder: this.deps.traceRecorder,
			blobSink: this.deps.blobSink,
			getTraceScope: () => traceScopeRef.current,
			appendEvent: (bid, type, payload, runId) => {
				store.appendEvent(
					bid,
					type as import('@ellie/db').EventType,
					payload as import('@ellie/db').EventPayloadMap[import('@ellie/db').EventType],
					runId
				)
			},
			eventStore: this.deps.eventStore
		}

		const host = new BranchRuntimeHost(branchId, store, {
			adapter,
			definition,
			services,
			traceScopeRef,
			agentOptions: guardrails ? { guardrails } : undefined,
			traceRecorder: this.deps.traceRecorder,
			blobSink: this.deps.blobSink
		})

		this.hosts.set(branchId, host)
		return host
	}

	private async resolveAdapter(): Promise<AnyTextAdapter | null> {
		if (this.adapterResolved) {
			if (this.adapter) {
				await this.ensureTokenFresh()
			}
			return this.adapter
		}

		if (this.adapterInflight) return this.adapterInflight
		this.adapterInflight = this.doResolveAdapter().finally(
			() => {
				this.adapterInflight = null
			}
		)
		return this.adapterInflight
	}

	private async doResolveAdapter(): Promise<AnyTextAdapter | null> {
		const adapter = await resolveAgentAdapter(
			this.deps.credentialsPath
		)
		this.adapter = adapter
		this.adapterResolved = true
		return adapter
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
			if (freshAdapter) {
				this.adapter = freshAdapter
				// Update all existing hosts with fresh adapter
				for (const host of this.hosts.values()) {
					host.updateAdapter(freshAdapter)
				}
			} else {
				this.invalidate()
			}
		}
	}
}
