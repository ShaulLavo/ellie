/**
 * Memory orchestrator — bridges Hindsight memory with the agent event loop.
 *
 * Two responsibilities:
 *   1. **Recall**: Before the agent processes a user message, query memory
 *      banks in parallel and return context for system prompt injection.
 *   2. **Retain**: After the agent completes (or on long turns), chunk
 *      unprocessed transcript events and store them as memories.
 *
 * Memory operations return payloads for tracing and prompt injection.
 * They no longer write first-class session DB rows.
 */

import type {
	Hindsight,
	MethodResult
} from '@ellie/hindsight'
import type { EventStore } from '@ellie/db'
import { createHash } from 'crypto'

const GLOBAL_BANK_NAME = 'ellie-global'

/** Max turns before triggering a retain flush. */
export const MAX_TURNS_PER_CHUNK = 6
/** Max chars across all pending turns before triggering a retain flush. */
export const MAX_CHARS_PER_CHUNK = 6000
/** A single turn above this char count triggers an immediate retain. */
export const IMMEDIATE_TURN_CHARS = 1200

/** Per-bank recall timeout in ms. */
const RECALL_TIMEOUT_MS = 2500
/** Maximum memories to return after merging across banks. */
const RECALL_MERGE_CAP = 12
/** Maximum fact texts to include in the retain event for UI compactness. */
const FACTS_UI_CAP = 8

interface BankSearchResult {
	bankId: string
	status: 'ok' | 'error' | 'timeout'
	error?: string
	memoryCount: number
	methodResults?: Record<string, MethodResult>
}

interface MemoryRecallPayload {
	parts: Array<{
		type: 'memory'
		text: string
		count: number
		memories?: Array<{ text: string; model?: string }>
		duration_ms?: number
	}>
	query: string
	bankIds: string[]
	searchResults: BankSearchResult[]
	timestamp: number
}

interface MemoryRetainPayload {
	parts: Array<{
		type: 'memory-retain'
		factsStored: number
		facts: string[]
		model?: string
		duration_ms?: number
	}>
	trigger: 'turn_count' | 'char_count' | 'immediate_turn'
	bankIds: string[]
	seqFrom: number
	seqTo: number
	timestamp: number
}

interface TranscriptTurn {
	role: 'user' | 'assistant'
	content: string
	seq: number
}

interface MemoryOrchestratorConfig {
	hindsight: Hindsight
	eventStore: EventStore
	workspaceDir: string
}

export class MemoryOrchestrator {
	private readonly hindsight: Hindsight
	private readonly eventStore: EventStore
	private readonly workspaceDir: string
	private readonly projectBankName: string
	/** Guard against concurrent evaluateRetain for the same session. */
	private retainInFlight = new Set<string>()

	constructor(config: MemoryOrchestratorConfig) {
		this.hindsight = config.hindsight
		this.eventStore = config.eventStore
		this.workspaceDir = config.workspaceDir
		this.projectBankName = `ellie-project-${hashWorkspace(config.workspaceDir)}`
	}

	/**
	 * Run recall against both banks in parallel.
	 * Returns the merged payload for a `memory_recall` event plus the
	 * context string to inject into the system prompt.
	 *
	 * If recall fails entirely, returns null (caller should log and proceed).
	 */
	async recall(query: string): Promise<{
		payload: MemoryRecallPayload
		contextBlock: string
	} | null> {
		const start = performance.now()
		const bankIds = this.resolveBankIds()

		// Recall from all banks in parallel with per-bank timeout
		const results = await Promise.allSettled(
			bankIds.map(bankId =>
				withTimeout(
					this.hindsight.recall(bankId, query, {
						limit: RECALL_MERGE_CAP
					}),
					RECALL_TIMEOUT_MS
				)
			)
		)

		// Collect successful results + per-bank diagnostics
		const { memories, succeededBankIds, searchResults } =
			collectRecallResults(results, bankIds)

		if (memories.length === 0) {
			const durationMs = Math.round(
				performance.now() - start
			)
			// Return empty recall event (still emit for UI visibility)
			return {
				payload: {
					parts: [
						{
							type: 'memory',
							text: 'No relevant memories found.',
							count: 0,
							memories: [],
							duration_ms: durationMs
						}
					],
					query,
					bankIds: succeededBankIds,
					searchResults,
					timestamp: Date.now()
				},
				contextBlock: ''
			}
		}

		// Dedupe by normalized text hash and sort by score
		const seen = new Set<string>()
		const deduped = memories.filter(m => {
			const hash = normalizeHash(m.text)
			if (seen.has(hash)) return false
			seen.add(hash)
			return true
		})
		deduped.sort((a, b) => b.score - a.score)
		const capped = deduped.slice(0, RECALL_MERGE_CAP)

		const durationMs = Math.round(performance.now() - start)

		// Build context block for system prompt injection
		const contextBlock = capped
			.map((m, i) => `  ${i + 1}. ${m.text}`)
			.join('\n')
		const formattedContext = `<recalled_memories>\n${contextBlock}\n</recalled_memories>`

		const payload: MemoryRecallPayload = {
			parts: [
				{
					type: 'memory',
					text: `Recalled ${capped.length} ${capped.length === 1 ? 'memory' : 'memories'}`,
					count: capped.length,
					memories: capped.map(m => ({
						text: m.text,
						model: m.model
					})),
					duration_ms: durationMs
				}
			],
			query,
			bankIds: succeededBankIds,
			searchResults,
			timestamp: Date.now()
		}

		return { payload, contextBlock: formattedContext }
	}

	/**
	 * Evaluate whether a retain should be triggered, and if so, run it.
	 *
	 * Uses per-session cursor keys in KV to track which events have already
	 * been retained. Returns the payload for a `memory_retain` event if
	 * retain was triggered, or null if conditions weren't met.
	 */
	async evaluateRetain(
		sessionId: string,
		force?: boolean
	): Promise<MemoryRetainPayload | null> {
		if (this.retainInFlight.has(sessionId)) {
			return null
		}
		this.retainInFlight.add(sessionId)
		try {
			return await this._evaluateRetain(sessionId, force)
		} finally {
			this.retainInFlight.delete(sessionId)
		}
	}

	private async _evaluateRetain(
		sessionId: string,
		force?: boolean
	): Promise<MemoryRetainPayload | null> {
		const bankIds = this.resolveBankIds()
		const turns = this.collectUnprocessedTurns(sessionId)

		const totalChars = turns.reduce(
			(sum, t) => sum + t.content.length,
			0
		)

		if (turns.length === 0) {
			return null
		}

		// Determine trigger
		const lastTurn = turns[turns.length - 1]
		const hasImmediateTurn = turns.some(
			t => t.content.length >= IMMEDIATE_TURN_CHARS
		)

		let trigger:
			| 'turn_count'
			| 'char_count'
			| 'immediate_turn'

		if (force && hasImmediateTurn) {
			trigger = 'immediate_turn'
		} else if (turns.length >= MAX_TURNS_PER_CHUNK) {
			trigger = 'turn_count'
		} else if (totalChars >= MAX_CHARS_PER_CHUNK) {
			trigger = 'char_count'
		} else if (hasImmediateTurn) {
			trigger = 'immediate_turn'
		} else {
			return null
		}

		const start = performance.now()
		const seqFrom = turns[0].seq
		const seqTo = lastTurn.seq

		// Build transcript for Hindsight
		const transcript = turns.map(t => ({
			role: t.role,
			content: t.content
		}))
		const documentId = `${sessionId}:${seqFrom}-${seqTo}`
		const content = JSON.stringify(transcript)

		const facts = await this.hindsight.extract(
			bankIds[0],
			content
		)
		const results = await Promise.allSettled(
			bankIds.map(bankId =>
				this.hindsight.retain(bankId, content, {
					documentId,
					facts
				})
			)
		)

		// Update cursors only for successful banks
		let totalFacts = 0
		const allFacts: string[] = []
		const succeededBankIds: string[] = []

		for (let i = 0; i < results.length; i++) {
			const result = results[i]
			if (result.status === 'rejected') {
				const errMsg =
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason)
				// UNIQUE constraint means the document is already stored —
				// advance the cursor so we don't reprocess the same range.
				if (errMsg.includes('UNIQUE constraint')) {
					const cursorKey = this.cursorKey(
						bankIds[i],
						sessionId
					)
					this.eventStore.setKv(cursorKey, String(seqTo))
					succeededBankIds.push(bankIds[i])
					continue
				}
				continue
			}
			if (result.status !== 'fulfilled' || !result.value) {
				continue
			}

			succeededBankIds.push(bankIds[i])
			const cursorKey = this.cursorKey(
				bankIds[i],
				sessionId
			)
			this.eventStore.setKv(cursorKey, String(seqTo))
			// RetainResult.memories is the array of stored MemoryUnit objects
			const memories = result.value.memories ?? []
			totalFacts += memories.length
			for (const m of memories) {
				allFacts.push(m.content)
			}
		}

		if (succeededBankIds.length === 0) {
			return null
		}

		const durationMs = Math.round(performance.now() - start)

		return {
			parts: [
				{
					type: 'memory-retain',
					factsStored: totalFacts,
					facts: allFacts.slice(0, FACTS_UI_CAP),
					duration_ms: durationMs
				}
			],
			trigger,
			bankIds: succeededBankIds,
			seqFrom,
			seqTo,
			timestamp: Date.now()
		}
	}

	/**
	 * Resolve bank IDs, lazily creating banks if they don't exist.
	 */
	private resolveBankIds(): string[] {
		const ids: string[] = []

		const global = this.ensureBank(GLOBAL_BANK_NAME)
		ids.push(global)

		const project = this.ensureBank(this.projectBankName)
		ids.push(project)

		return ids
	}

	private ensureBank(name: string): string {
		const existing = this.hindsight.getBank(name)
		if (existing) return existing.id

		const created = this.hindsight.createBank(name, {
			description:
				name === GLOBAL_BANK_NAME
					? 'Global memory bank for cross-project knowledge'
					: `Project memory bank for ${this.workspaceDir}`
		})
		return created.id
	}

	/**
	 * Collect unprocessed transcript turns from the event store.
	 * Uses the minimum cursor across all banks to determine the starting point.
	 */
	private collectUnprocessedTurns(
		sessionId: string
	): TranscriptTurn[] {
		const bankIds = this.resolveBankIds()

		// Find the minimum cursor across all banks
		let minCursor = Infinity
		for (const bankId of bankIds) {
			const cursorKey = this.cursorKey(bankId, sessionId)
			const raw = this.eventStore.getKv(cursorKey)
			const cursor = raw ? Number(raw) : 0
			if (cursor < minCursor) minCursor = cursor
		}
		if (minCursor === Infinity) minCursor = 0

		// Query unprocessed events (unified types only)
		const rows = this.eventStore.query({
			sessionId,
			afterSeq: minCursor,
			types: ['user_message', 'assistant_message']
		})

		const mapped = rows.map(row => {
			return rowToTranscriptTurn(row)
		})

		return mapped.filter(
			(t): t is TranscriptTurn =>
				t !== null && t.content.length > 0
		)
	}

	private cursorKey(
		bankId: string,
		sessionId: string
	): string {
		return `memory.cursor.${bankId}:${sessionId}`
	}
}

function extractTextContent(
	content:
		| string
		| Array<{ type: string; text?: string }>
		| undefined
): string {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content
			.filter(c => c.type === 'text')
			.map(c => c.text ?? '')
			.join('')
	}
	return ''
}

/** Parse an event row into a TranscriptTurn, or null on failure. */
function rowToTranscriptTurn(row: {
	type: string
	payload: string
	seq: number
}): TranscriptTurn | null {
	try {
		const parsed = JSON.parse(row.payload) as Record<
			string,
			unknown
		>

		if (row.type === 'assistant_message') {
			// Skip in-flight streaming messages
			if (parsed.streaming === true) return null
			const msg = parsed.message as {
				content?:
					| string
					| Array<{ type: string; text?: string }>
			}
			return {
				role: 'assistant',
				content: extractTextContent(msg?.content),
				seq: row.seq
			}
		}

		// user_message
		return {
			role: 'user',
			content: extractTextContent(
				parsed.content as
					| string
					| Array<{ type: string; text?: string }>
					| undefined
			),
			seq: row.seq
		}
	} catch {
		return null
	}
}

/** Collect memories and diagnostics from parallel recall results. */
function collectRecallResults(
	results: PromiseSettledResult<unknown>[],
	bankIds: string[]
): {
	memories: Array<{
		text: string
		score: number
		model?: string
	}>
	succeededBankIds: string[]
	searchResults: BankSearchResult[]
} {
	const memories: Array<{
		text: string
		score: number
		model?: string
	}> = []
	const succeededBankIds: string[] = []
	const searchResults: BankSearchResult[] = []

	for (let i = 0; i < results.length; i++) {
		const result = results[i]
		if (result.status === 'rejected') {
			const err = result.reason
			const isTimeout =
				err instanceof Error &&
				err.message.startsWith('Timeout')
			searchResults.push({
				bankId: bankIds[i],
				status: isTimeout ? 'timeout' : 'error',
				error:
					err instanceof Error ? err.message : String(err),
				memoryCount: 0
			})
			continue
		}
		if (!result.value) continue

		succeededBankIds.push(bankIds[i])
		const val = result.value as {
			memories: Array<{
				memory: { content: string }
				score?: number
			}>
			methodResults?: Record<string, MethodResult>
		}
		for (const mem of val.memories) {
			memories.push({
				text: mem.memory.content,
				score: mem.score ?? 0
			})
		}
		searchResults.push({
			bankId: bankIds[i],
			status: 'ok',
			memoryCount: val.memories.length,
			methodResults: val.methodResults
		})
	}

	return { memories, succeededBankIds, searchResults }
}

function hashWorkspace(dir: string): string {
	return createHash('sha256')
		.update(dir)
		.digest('hex')
		.slice(0, 12)
}

function normalizeHash(text: string): string {
	return createHash('sha256')
		.update(text.trim().toLowerCase())
		.digest('hex')
		.slice(0, 16)
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Timeout after ${ms}ms`)),
			ms
		)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		clearTimeout(timer!)
	}
}
