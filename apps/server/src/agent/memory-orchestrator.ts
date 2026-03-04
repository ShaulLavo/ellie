/**
 * Memory orchestrator — bridges Hindsight memory with the agent event loop.
 *
 * Two responsibilities:
 *   1. **Recall**: Before the agent processes a user message, query memory
 *      banks in parallel and return context for system prompt injection.
 *   2. **Retain**: After the agent completes (or on long turns), chunk
 *      unprocessed transcript events and store them as memories.
 *
 * Memory operations emit first-class `memory_recall` / `memory_retain`
 * events — never synthetic tool_call/tool_result.
 */

import type {
	Hindsight,
	MethodResult
} from '@ellie/hindsight'
import type { EventStore } from '@ellie/db'
import { createHash } from 'crypto'

// ── Constants ────────────────────────────────────────────────────────────────

const GLOBAL_BANK_NAME = 'ellie-global'

/** Max turns before triggering a retain flush. */
export const MAX_TURNS_PER_CHUNK = 5
/** Max chars across all pending turns before triggering a retain flush. */
export const MAX_CHARS_PER_CHUNK = 4000
/** A single turn above this char count triggers an immediate retain. */
export const IMMEDIATE_TURN_CHARS = 1200

/** Per-bank recall timeout in ms. */
const RECALL_TIMEOUT_MS = 2500
/** Maximum memories to return after merging across banks. */
const RECALL_MERGE_CAP = 12
/** Maximum fact texts to include in the retain event for UI compactness. */
const FACTS_UI_CAP = 8

// ── Types ────────────────────────────────────────────────────────────────────

export interface BankSearchResult {
	bankId: string
	status: 'ok' | 'error' | 'timeout'
	error?: string
	memoryCount: number
	methodResults?: Record<string, MethodResult>
}

export interface MemoryRecallPayload {
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

export interface MemoryRetainPayload {
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

export interface MemoryOrchestratorConfig {
	hindsight: Hindsight
	eventStore: EventStore
	workspaceDir: string
	/** Tier 2 trace callback — JSONL only, no DB write. Best-effort. */
	onTrace?: (entry: {
		type: string
		payload: unknown
	}) => void
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class MemoryOrchestrator {
	private readonly hindsight: Hindsight
	private readonly eventStore: EventStore
	private readonly workspaceDir: string
	private readonly projectBankName: string
	private readonly onTrace?: (entry: {
		type: string
		payload: unknown
	}) => void

	constructor(config: MemoryOrchestratorConfig) {
		this.hindsight = config.hindsight
		this.eventStore = config.eventStore
		this.workspaceDir = config.workspaceDir
		this.projectBankName = `ellie-project-${hashWorkspace(config.workspaceDir)}`
		this.onTrace = config.onTrace
	}

	private trace(
		type: string,
		payload: Record<string, unknown>
	): void {
		try {
			this.onTrace?.({ type, payload })
		} catch {
			// best-effort
		}
	}

	// ── Recall ──────────────────────────────────────────────────────────────

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

		this.trace('memory.recall_start', { query, bankIds })

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
		const memories: Array<{
			text: string
			score: number
			model?: string
		}> = []
		const succeededBankIds: string[] = []
		const searchResults: BankSearchResult[] = []

		for (let i = 0; i < results.length; i++) {
			const result = results[i]
			if (result.status === 'fulfilled' && result.value) {
				succeededBankIds.push(bankIds[i])
				const val = result.value
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
			} else if (result.status === 'rejected') {
				const err = result.reason
				const isTimeout =
					err instanceof Error &&
					err.message.startsWith('Timeout')
				searchResults.push({
					bankId: bankIds[i],
					status: isTimeout ? 'timeout' : 'error',
					error:
						err instanceof Error
							? err.message
							: String(err),
					memoryCount: 0
				})
			}
		}

		if (memories.length === 0) {
			const durationMs = Math.round(
				performance.now() - start
			)
			this.trace('memory.recall_complete', {
				bankCount: bankIds.length,
				memoriesFound: 0,
				durationMs,
				searchResults
			})
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

		this.trace('memory.recall_complete', {
			bankCount: bankIds.length,
			memoriesFound: capped.length,
			durationMs,
			searchResults
		})

		return { payload, contextBlock: formattedContext }
	}

	// ── Retain ──────────────────────────────────────────────────────────────

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
		const bankIds = this.resolveBankIds()
		const turns = this.collectUnprocessedTurns(sessionId)
		if (turns.length === 0) {
			this.trace('memory.retain_skip', {
				sessionId,
				reason: 'no_unprocessed_turns'
			})
			return null
		}

		// Determine trigger
		const totalChars = turns.reduce(
			(sum, t) => sum + t.content.length,
			0
		)
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
			this.trace('memory.retain_skip', {
				sessionId,
				reason: 'thresholds_not_met',
				turnCount: turns.length,
				totalChars,
				maxTurnChars: Math.max(
					...turns.map(t => t.content.length)
				),
				thresholds: {
					maxTurns: MAX_TURNS_PER_CHUNK,
					maxChars: MAX_CHARS_PER_CHUNK,
					immediateTurnChars: IMMEDIATE_TURN_CHARS
				}
			})
			return null // Thresholds not met
		}

		const start = performance.now()
		const seqFrom = turns[0].seq
		const seqTo = lastTurn.seq

		this.trace('memory.retain_start', {
			sessionId,
			trigger,
			turnCount: turns.length,
			totalChars,
			seqFrom,
			seqTo
		})

		// Build transcript for Hindsight
		const transcript = turns.map(t => ({
			role: t.role,
			content: t.content
		}))
		const documentId = `${sessionId}:${seqFrom}-${seqTo}`
		const content = JSON.stringify(transcript)

		// Retain into all banks in parallel
		const results = await Promise.allSettled(
			bankIds.map(bankId =>
				this.hindsight.retain(bankId, content, {
					documentId
				})
			)
		)

		// Update cursors only for successful banks
		let totalFacts = 0
		const allFacts: string[] = []
		const succeededBankIds: string[] = []

		for (let i = 0; i < results.length; i++) {
			const result = results[i]
			if (result.status === 'fulfilled' && result.value) {
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
			} else if (result.status === 'rejected') {
				this.trace('memory.retain_bank_error', {
					sessionId,
					bankId: bankIds[i],
					error:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
				})
			}
		}

		if (succeededBankIds.length === 0) {
			this.trace('memory.retain_complete', {
				sessionId,
				trigger,
				factsStored: 0,
				succeededBanks: 0,
				durationMs: Math.round(performance.now() - start)
			})
			return null
		}

		const durationMs = Math.round(performance.now() - start)

		this.trace('memory.retain_complete', {
			sessionId,
			trigger,
			factsStored: totalFacts,
			succeededBanks: succeededBankIds.length,
			durationMs
		})

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

	// ── Internal helpers ────────────────────────────────────────────────────

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

		// Query unprocessed events
		const rows = this.eventStore.query({
			sessionId,
			afterSeq: minCursor,
			types: ['user_message', 'assistant_final']
		})

		return rows
			.map(row => {
				try {
					const parsed = JSON.parse(row.payload) as {
						role?: string
						content?:
							| string
							| Array<{
									type: string
									text?: string
							  }>
					}
					const role =
						row.type === 'user_message'
							? 'user'
							: 'assistant'
					let text = ''
					if (typeof parsed.content === 'string') {
						text = parsed.content
					} else if (Array.isArray(parsed.content)) {
						text = parsed.content
							.filter(c => c.type === 'text')
							.map(c => c.text ?? '')
							.join('')
					}
					return {
						role: role as 'user' | 'assistant',
						content: text,
						seq: row.seq
					}
				} catch {
					return null
				}
			})
			.filter(
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

// ── Utility functions ────────────────────────────────────────────────────────

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

function withTimeout<T>(
	promise: Promise<T>,
	ms: number
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timeout after ${ms}ms`)),
			ms
		)
		promise
			.then(v => {
				clearTimeout(timer)
				resolve(v)
			})
			.catch(e => {
				clearTimeout(timer)
				reject(e)
			})
	})
}
