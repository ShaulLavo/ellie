/**
 * Trace recorder — writes TraceEventEnvelopes to day-partitioned JSONL files.
 *
 * Layout: <traceDir>/YYYY-MM-DD/HH-MM-SS-<traceKind>-<traceId>.jsonl
 * Index:  <traceDir>/_index.jsonl  (one entry per trace for fast lookup)
 *
 * Monotonic seq counter per trace.
 */

import {
	mkdirSync,
	appendFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { ulid } from 'fast-ulid'
import type {
	TraceEventEnvelope,
	TraceScope,
	TraceKind,
	BlobRef
} from './types'

export interface TraceIndexEntry {
	traceId: string
	relativePath: string
	createdAt: number
	traceKind: TraceKind
	sessionId?: string
	runId?: string
}

const INDEX_FILENAME = '_index.jsonl'

export class TraceRecorder {
	readonly #traceDir: string
	/** Per-trace monotonic sequence counters. */
	readonly #seqCounters = new Map<string, number>()
	/** In-memory index: traceId → entry. */
	readonly #index = new Map<string, TraceIndexEntry>()
	/** Cached absolute file paths for traces already written to this session. */
	readonly #pathCache = new Map<string, string>()

	constructor(traceDir: string) {
		this.#traceDir = traceDir
		mkdirSync(traceDir, { recursive: true })
		this.#loadOrRebuildIndex()
	}

	/**
	 * Record a trace event. Writes to JSONL and returns the envelope.
	 */
	record(
		scope: TraceScope,
		kind: string,
		component: string,
		payload: unknown,
		blobRefs?: BlobRef[]
	): TraceEventEnvelope {
		const seq = this.#nextSeq(scope.traceId)

		const envelope: TraceEventEnvelope = {
			eventId: ulid(),
			traceId: scope.traceId,
			spanId: scope.spanId,
			parentSpanId: scope.parentSpanId,
			sessionId: scope.sessionId,
			runId: scope.runId,
			traceKind: scope.traceKind,
			kind,
			ts: Date.now(),
			seq,
			component,
			payload,
			blobRefs:
				blobRefs && blobRefs.length > 0
					? blobRefs
					: undefined
		}

		const filePath = this.#resolveTracePath(scope)
		const line = JSON.stringify(envelope) + '\n'
		appendFileSync(filePath, line, 'utf-8')

		return envelope
	}

	/**
	 * Read all events for a trace from its JSONL file.
	 */
	readTrace(traceId: string): TraceEventEnvelope[] {
		const entry = this.#index.get(traceId)
		if (!entry) return []

		const filePath = join(
			this.#traceDir,
			entry.relativePath
		)
		if (!existsSync(filePath)) return []

		const content = readFileSync(filePath, 'utf-8')
		const lines = content.split('\n').filter(l => l.trim())
		const events: TraceEventEnvelope[] = []
		for (let i = 0; i < lines.length; i++) {
			try {
				events.push(
					JSON.parse(lines[i]) as TraceEventEnvelope
				)
			} catch {
				console.warn(
					`[TraceRecorder] Skipping malformed JSONL line ${i + 1} in ${filePath}`
				)
			}
		}
		return events
	}

	/**
	 * List all trace IDs from the index.
	 */
	listTraceIds(): string[] {
		return Array.from(this.#index.keys())
	}

	/**
	 * List all trace index entries, sorted by createdAt ascending.
	 */
	listTraces(): TraceIndexEntry[] {
		return Array.from(this.#index.values()).sort(
			(a, b) => a.createdAt - b.createdAt
		)
	}

	/**
	 * Find traces that belong to a specific session.
	 */
	findTracesBySession(sessionId: string): Array<{
		traceId: string
		ts: number
		traceKind: TraceKind
	}> {
		const results: Array<{
			traceId: string
			ts: number
			traceKind: TraceKind
		}> = []

		for (const entry of this.#index.values()) {
			if (entry.sessionId === sessionId) {
				results.push({
					traceId: entry.traceId,
					ts: entry.createdAt,
					traceKind: entry.traceKind
				})
			}
		}

		return results.sort((a, b) => a.ts - b.ts)
	}

	// ── Path resolution ─────────────────────────────────────────────────

	/**
	 * Resolve the absolute file path for a trace. On first write for a traceId,
	 * assigns a day-partitioned path and updates the index.
	 */
	#resolveTracePath(scope: TraceScope): string {
		const cached = this.#pathCache.get(scope.traceId)
		if (cached) return cached

		// Check the in-memory index (trace may exist from a prior session)
		const existing = this.#index.get(scope.traceId)
		if (existing) {
			const absPath = join(
				this.#traceDir,
				existing.relativePath
			)
			this.#pathCache.set(scope.traceId, absPath)
			return absPath
		}

		TraceRecorder.#validateId(scope.traceId)

		// Assign new path
		const now = new Date()
		const dayDir = TraceRecorder.#formatDayDir(now)
		const filename = TraceRecorder.#formatFilename(
			now,
			scope.traceKind,
			scope.traceId
		)
		const relPath = `${dayDir}/${filename}`
		const absPath = join(this.#traceDir, relPath)

		// Ensure day directory exists
		mkdirSync(join(this.#traceDir, dayDir), {
			recursive: true
		})

		// Create index entry
		const entry: TraceIndexEntry = {
			traceId: scope.traceId,
			relativePath: relPath,
			createdAt: Date.now(),
			traceKind: scope.traceKind,
			sessionId: scope.sessionId,
			runId: scope.runId
		}

		this.#index.set(scope.traceId, entry)
		this.#pathCache.set(scope.traceId, absPath)

		// Append to persistent index
		appendFileSync(
			join(this.#traceDir, INDEX_FILENAME),
			JSON.stringify(entry) + '\n',
			'utf-8'
		)

		return absPath
	}

	// ── Index loading / rebuilding ──────────────────────────────────────

	#loadOrRebuildIndex(): void {
		const indexPath = join(this.#traceDir, INDEX_FILENAME)
		if (!existsSync(indexPath)) {
			this.#rebuildIndex()
			return
		}

		try {
			const content = readFileSync(indexPath, 'utf-8')
			const lines = content
				.split('\n')
				.filter(l => l.trim())
			for (const line of lines) {
				const entry = JSON.parse(line) as TraceIndexEntry
				if (
					!entry.traceId ||
					!entry.relativePath ||
					!entry.traceKind
				) {
					throw new Error(
						`Invalid index entry: missing required field`
					)
				}
				if (this.#index.has(entry.traceId)) {
					throw new Error(
						`Duplicate traceId in index: ${entry.traceId}`
					)
				}
				this.#index.set(entry.traceId, entry)
			}
		} catch (err) {
			console.warn(
				`[TraceRecorder] Index load failed, rebuilding:`,
				err instanceof Error ? err.message : String(err)
			)
			this.#index.clear()
			this.#rebuildIndex()
		}
	}

	#rebuildIndex(): void {
		this.#index.clear()

		const jsonlFiles = TraceRecorder.#findJsonlFiles(
			this.#traceDir,
			this.#traceDir
		)

		for (const relPath of jsonlFiles) {
			const absPath = join(this.#traceDir, relPath)
			const firstEvent =
				TraceRecorder.#readFirstLine(absPath)
			if (!firstEvent) continue
			// Skip files without traceKind (old format)
			if (!firstEvent.traceKind) continue

			const entry: TraceIndexEntry = {
				traceId: firstEvent.traceId,
				relativePath: relPath,
				createdAt: firstEvent.ts,
				traceKind: firstEvent.traceKind as TraceKind,
				sessionId: firstEvent.sessionId,
				runId: firstEvent.runId
			}
			this.#index.set(entry.traceId, entry)
		}

		// Write fresh index
		const indexPath = join(this.#traceDir, INDEX_FILENAME)
		const lines = Array.from(this.#index.values())
			.map(e => JSON.stringify(e))
			.join('\n')
		writeFileSync(
			indexPath,
			lines ? lines + '\n' : '',
			'utf-8'
		)
	}

	// ── Helpers ─────────────────────────────────────────────────────────

	/** Get the next monotonic sequence number for a trace. */
	#nextSeq(traceId: string): number {
		const current = this.#seqCounters.get(traceId) ?? 0
		this.#seqCounters.set(traceId, current + 1)
		return current
	}

	/** Validate traceId to prevent path traversal. */
	static #SAFE_ID = /^[A-Za-z0-9_-]+$/

	static #validateId(id: string): void {
		if (!TraceRecorder.#SAFE_ID.test(id)) {
			throw new Error(
				`Invalid traceId: must match /^[A-Za-z0-9_-]+$/, got "${id}"`
			)
		}
	}

	/** Format local day directory: YYYY-MM-DD */
	static #formatDayDir(date: Date): string {
		const y = date.getFullYear()
		const m = String(date.getMonth() + 1).padStart(2, '0')
		const d = String(date.getDate()).padStart(2, '0')
		return `${y}-${m}-${d}`
	}

	/** Format filename: HH-MM-SS-<traceKind>-<traceId>.jsonl (local time) */
	static #formatFilename(
		date: Date,
		traceKind: TraceKind,
		traceId: string
	): string {
		const h = String(date.getHours()).padStart(2, '0')
		const min = String(date.getMinutes()).padStart(2, '0')
		const s = String(date.getSeconds()).padStart(2, '0')
		return `${h}-${min}-${s}-${traceKind}-${traceId}.jsonl`
	}

	/** Recursively find all .jsonl files, returning paths relative to baseDir. */
	static #findJsonlFiles(
		dir: string,
		baseDir: string
	): string[] {
		const results: string[] = []
		if (!existsSync(dir)) return results

		const entries = readdirSync(dir, {
			withFileTypes: true
		})
		for (const entry of entries) {
			const fullPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				results.push(
					...TraceRecorder.#findJsonlFiles(
						fullPath,
						baseDir
					)
				)
			} else if (
				entry.name.endsWith('.jsonl') &&
				entry.name !== INDEX_FILENAME
			) {
				results.push(relative(baseDir, fullPath))
			}
		}
		return results
	}

	/** Read and parse the first line of a JSONL file. */
	static #readFirstLine(
		filePath: string
	): TraceEventEnvelope | null {
		try {
			const content = readFileSync(filePath, 'utf-8')
			const newlineIdx = content.indexOf('\n')
			const firstLine = (
				newlineIdx >= 0
					? content.slice(0, newlineIdx)
					: content
			).trim()
			if (!firstLine) return null
			return JSON.parse(firstLine) as TraceEventEnvelope
		} catch {
			return null
		}
	}
}
