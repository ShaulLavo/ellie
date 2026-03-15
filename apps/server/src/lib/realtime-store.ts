import type {
	EventStore,
	EventRow,
	EventType,
	EventPayloadMap,
	AgentMessage,
	BranchRow,
	ThreadRow
} from '@ellie/db'
import { isDurableEventType } from '@ellie/db'

export type BranchEvent =
	| { type: 'append'; event: EventRow }
	| { type: 'update'; event: EventRow }

type Listener<T> = (event: T) => void

const MAX_CLOSED_RUNS = 10_000

type AssistantChangeEvent = {
	type: 'assistant-changed'
	previousThreadId: string
	newThreadId: string
	newBranchId: string
}

interface TraceEntry {
	branchId: string
	/** Free-form type, e.g. 'memory.recall_start', 'controller.prompt_failed' */
	type: string
	runId?: string
	payload: unknown
}

export class RealtimeStore {
	readonly #store: EventStore
	readonly #listeners = new Map<
		string,
		Set<Listener<unknown>>
	>()
	readonly #closedRuns = new Set<string>()

	constructor(store: EventStore) {
		this.#store = store
	}

	get eventStore(): EventStore {
		return this.#store
	}

	// -- Default assistant thread management ----------------------------------

	getDefaultAssistantThread(): {
		threadId: string
		branchId: string
	} | null {
		const threadId = this.#store.getKv(
			'assistant.defaultThreadId'
		)
		if (!threadId) return null
		const thread = this.#store.getThread(threadId)
		if (!thread) return null
		const branchList = this.#store.listBranches(threadId)
		if (branchList.length === 0) return null
		return {
			threadId,
			branchId: branchList[0]!.id
		}
	}

	/**
	 * Idempotent daily thread creation. If a thread already exists
	 * for this agentId + dayKey, returns it. Otherwise creates a new one.
	 */
	resolveOrCreateAssistantThread(
		agentId: string,
		workspaceId: string,
		dayKey: string
	): { threadId: string; branchId: string } {
		// Check if thread already exists for this dayKey
		const existingThreads = this.#store.listThreads({
			agentType: 'assistant'
		})
		for (const t of existingThreads) {
			if (
				t.agentId === agentId &&
				t.dayKey === dayKey &&
				t.state === 'active'
			) {
				const branchList = this.#store.listBranches(t.id)
				if (branchList.length > 0) {
					return {
						threadId: t.id,
						branchId: branchList[0]!.id
					}
				}
			}
		}

		// Create new thread + root branch
		const thread = this.#store.createThread(
			agentId,
			'assistant',
			workspaceId,
			undefined,
			dayKey
		)
		const branch = this.#store.createBranch(thread.id)

		this.#store.setKv(
			'assistant.defaultThreadId',
			thread.id
		)
		this.#store.setKv('assistant.defaultDayKey', dayKey)

		return { threadId: thread.id, branchId: branch.id }
	}

	rotateAssistantThread(
		agentId: string,
		workspaceId: string,
		dayKey: string
	): { threadId: string; branchId: string } {
		const previous = this.getDefaultAssistantThread()

		// Mark old thread as view_only
		if (previous) {
			this.#store.updateThread(previous.threadId, {
				state: 'view_only'
			})
			this.#store.detachChannels(previous.threadId)
		}

		const result = this.resolveOrCreateAssistantThread(
			agentId,
			workspaceId,
			dayKey
		)

		// Persist a thread_created event in the new branch
		this.appendEvent(
			result.branchId,
			'thread_created',
			{
				previousThreadId: previous?.threadId,
				message: 'New day, new thread'
			},
			undefined,
			`thread_created:${result.threadId}`
		)

		this.#publish<AssistantChangeEvent>(
			'assistant-current',
			{
				type: 'assistant-changed',
				previousThreadId: previous?.threadId ?? '',
				newThreadId: result.threadId,
				newBranchId: result.branchId
			}
		)

		return result
	}

	subscribeToAssistantChange(
		listener: Listener<AssistantChangeEvent>
	): () => void {
		return this.#subscribe('assistant-current', listener)
	}

	// -- Thread/Branch pass-through methods -----------------------------------

	createThread(
		agentId: string,
		agentType: string,
		workspaceId: string,
		title?: string,
		dayKey?: string
	): ThreadRow {
		return this.#store.createThread(
			agentId,
			agentType,
			workspaceId,
			title,
			dayKey
		)
	}

	getThread(id: string): ThreadRow | undefined {
		return this.#store.getThread(id)
	}

	listThreads(filter?: {
		agentType?: string
		state?: string
	}): ThreadRow[] {
		return this.#store.listThreads(filter)
	}

	listBranches(threadId: string): BranchRow[] {
		return this.#store.listBranches(threadId)
	}

	createThreadWithBranch(
		agentId: string,
		agentType: string,
		workspaceId: string,
		title?: string
	): { threadId: string; branchId: string } {
		const thread = this.#store.createThread(
			agentId,
			agentType,
			workspaceId,
			title
		)
		const branch = this.#store.createBranch(thread.id)
		return { threadId: thread.id, branchId: branch.id }
	}

	createCodingThread(
		agentId: string,
		workspaceId: string,
		title: string
	): { threadId: string; branchId: string } {
		return this.createThreadWithBranch(
			agentId,
			'coding',
			workspaceId,
			title
		)
	}

	forkBranch(
		branchId: string,
		fromEventId: number,
		fromSeq: number
	): BranchRow {
		const parent = this.#store.getBranch(branchId)
		if (!parent) {
			throw new Error(`Branch not found: ${branchId}`)
		}
		return this.#store.createBranch(
			parent.threadId,
			branchId,
			fromEventId,
			fromSeq
		)
	}

	// -- Branch session-like methods ------------------------------------------

	getBranch(branchId: string): BranchRow | undefined {
		return this.#store.getBranch(branchId)
	}

	ensureBranch(branchId: string): void {
		if (!this.#store.getBranch(branchId)) {
			throw new Error(`Branch not found: ${branchId}`)
		}
	}

	hasBranch(branchId: string): boolean {
		return this.#store.getBranch(branchId) !== undefined
	}

	deleteBranch(branchId: string): void {
		this.#store.deleteBranch(branchId)
		this.#listeners.delete(`branch:${branchId}`)

		for (const key of this.#closedRuns) {
			if (key.startsWith(`${branchId}:`)) {
				this.#closedRuns.delete(key)
			}
		}
	}

	/**
	 * Broadcast an event to SSE subscribers without persisting to the DB.
	 */
	publishEphemeral<T extends EventType>(
		branchId: string,
		type: T,
		payload: EventPayloadMap[T],
		runId?: string
	): void {
		this.#publish(`branch:${branchId}`, {
			type: 'append',
			event: {
				id: -1,
				branchId,
				seq: -1,
				runId: runId ?? null,
				type,
				payload: JSON.stringify(payload),
				dedupeKey: null,
				createdAt: Date.now()
			}
		} satisfies BranchEvent)
	}

	publishTraceEphemeral(entry: TraceEntry): void {
		this.#publish(`branch:${entry.branchId}`, {
			type: 'append',
			event: {
				id: -1,
				branchId: entry.branchId,
				seq: -1,
				runId: entry.runId ?? null,
				type: entry.type,
				payload: JSON.stringify(entry.payload),
				dedupeKey: null,
				createdAt: Date.now()
			}
		} satisfies BranchEvent)
	}

	appendEvent<T extends EventType>(
		branchId: string,
		type: T,
		payload: EventPayloadMap[T],
		runId?: string,
		dedupeKey?: string
	): EventRow {
		if (!isDurableEventType(type)) {
			return {
				id: -1,
				branchId,
				seq: -1,
				runId: runId ?? null,
				type,
				payload: JSON.stringify(payload),
				dedupeKey: dedupeKey ?? null,
				createdAt: Date.now()
			}
		}

		const row = this.#store.append({
			branchId,
			type,
			payload,
			runId,
			dedupeKey
		})

		this.#publish(`branch:${branchId}`, {
			type: 'append',
			event: row
		} satisfies BranchEvent)

		if (type === 'run_closed' && runId) {
			this.#closedRuns.add(this.#runKey(branchId, runId))
			if (this.#closedRuns.size > MAX_CLOSED_RUNS) {
				this.#closedRuns.clear()
			}
		}

		return row
	}

	updateEvent(
		id: number,
		payload: unknown,
		branchId: string
	): EventRow {
		const row = this.#store.update(id, payload)

		this.#publish(`branch:${branchId}`, {
			type: 'update',
			event: row
		} satisfies BranchEvent)

		return row
	}

	updateEventRunId(
		id: number,
		runId: string,
		branchId: string
	): EventRow {
		const row = this.#store.updateRunId(id, runId)

		this.#publish(`branch:${branchId}`, {
			type: 'update',
			event: row
		} satisfies BranchEvent)

		return row
	}

	closeAgentRun(branchId: string, runId: string): void {
		if (this.isAgentRunClosed(branchId, runId)) return
		this.appendEvent(
			branchId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)
	}

	isAgentRunClosed(
		branchId: string,
		runId: string
	): boolean {
		if (this.#closedRuns.has(this.#runKey(branchId, runId)))
			return true

		const closedEvents = this.#store.query({
			branchId,
			runId,
			types: ['run_closed'],
			limit: 1
		})
		if (closedEvents.length > 0) {
			this.#closedRuns.add(this.#runKey(branchId, runId))
			return true
		}
		return false
	}

	listAgentMessages(branchId: string): AgentMessage[] {
		return this.#store.getConversationHistory(branchId)
	}

	queryEvents(
		branchId: string,
		afterSeq?: number,
		types?: EventType[],
		limit?: number
	) {
		return this.#store.query({
			branchId,
			afterSeq,
			types,
			limit
		})
	}

	queryRunEvents(branchId: string, runId: string) {
		return this.#store.query({ branchId, runId })
	}

	subscribeToBranch(
		branchId: string,
		listener: Listener<BranchEvent>
	): () => void {
		return this.#subscribe(`branch:${branchId}`, listener)
	}

	#runKey(branchId: string, runId: string): string {
		return `${branchId}:${runId}`
	}

	#publish<T>(channel: string, event: T): void {
		const listeners = this.#listeners.get(channel)
		if (!listeners) return
		for (const listener of listeners) {
			;(listener as Listener<T>)(event)
		}
	}

	#subscribe<T>(
		channel: string,
		listener: Listener<T>
	): () => void {
		let listeners = this.#listeners.get(channel)
		if (!listeners) {
			listeners = new Set<Listener<unknown>>()
			this.#listeners.set(channel, listeners)
		}

		listeners.add(listener as Listener<unknown>)

		return () => {
			const existing = this.#listeners.get(channel)
			if (!existing) return
			existing.delete(listener as Listener<unknown>)
			if (existing.size !== 0) return
			this.#listeners.delete(channel)
		}
	}
}
