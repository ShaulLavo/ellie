/**
 * Trace recorder — writes TraceEventEnvelopes to JSONL files.
 *
 * One JSONL file per trace ID: <traceDir>/<traceId>.jsonl
 * Monotonic seq counter per trace.
 */

import {
	mkdirSync,
	appendFileSync,
	readFileSync,
	readdirSync,
	existsSync
} from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'fast-ulid'
import type {
	TraceEventEnvelope,
	TraceScope,
	BlobRef
} from './types'

export class TraceRecorder {
	readonly #traceDir: string
	/** Per-trace monotonic sequence counters. */
	readonly #seqCounters = new Map<string, number>()

	constructor(traceDir: string) {
		this.#traceDir = traceDir
		mkdirSync(traceDir, { recursive: true })
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

		const filePath = this.#tracePath(scope.traceId)
		const line = JSON.stringify(envelope) + '\n'
		appendFileSync(filePath, line, 'utf-8')

		return envelope
	}

	/**
	 * Read all events for a trace from its JSONL file.
	 */
	readTrace(traceId: string): TraceEventEnvelope[] {
		const filePath = this.#tracePath(traceId)
		if (!existsSync(filePath)) return []

		const content = readFileSync(filePath, 'utf-8')
		const lines = content.split('\n').filter(l => l.trim())
		return lines.map(
			line => JSON.parse(line) as TraceEventEnvelope
		)
	}

	/**
	 * List all trace IDs by scanning the trace directory.
	 */
	listTraceIds(): string[] {
		if (!existsSync(this.#traceDir)) return []
		return readdirSync(this.#traceDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => f.slice(0, -6)) // strip .jsonl
	}

	/**
	 * Find traces that belong to a specific session.
	 * Phase 1: file-scan approach — reads first event of each trace.
	 */
	findTracesBySession(sessionId: string): Array<{
		traceId: string
		ts: number
		kind: string
	}> {
		const results: Array<{
			traceId: string
			ts: number
			kind: string
		}> = []

		for (const traceId of this.listTraceIds()) {
			const events = this.readTrace(traceId)
			if (
				events.length > 0 &&
				events[0].sessionId === sessionId
			) {
				results.push({
					traceId,
					ts: events[0].ts,
					kind: events[0].kind
				})
			}
		}

		return results.sort((a, b) => a.ts - b.ts)
	}

	/** Get the next monotonic sequence number for a trace. */
	#nextSeq(traceId: string): number {
		const current = this.#seqCounters.get(traceId) ?? 0
		this.#seqCounters.set(traceId, current + 1)
		return current
	}

	/** Build the file path for a trace's JSONL file. */
	#tracePath(traceId: string): string {
		return join(this.#traceDir, `${traceId}.jsonl`)
	}
}
