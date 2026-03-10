/**
 * Append-only JSONL trace log for image generation.
 * Logs the essential events: what was requested, what was built, and how it ended.
 *
 * Trace file lives at: {dataDir}/image-gen.trace.jsonl
 * Tail it for live debugging:  tail -f <dataDir>/image-gen.trace.jsonl | jq .
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ── Trace event types ────────────────────────────────────────────────────────

export type ImageTraceEvent =
	| {
			type: 'recipe_built'
			recipe: Record<string, unknown>
	  }
	| {
			type: 'generation_success'
			sessionId: string
			uploadId: string
			mime: string
			durationMs: number
			recipe: Record<string, unknown>
	  }
	| {
			type: 'generation_failed'
			sessionId: string
			error: string
			durationMs: number
			recipe?: Record<string, unknown>
	  }

// ── Trace function ───────────────────────────────────────────────────────────

let tracePath: string | null = null

export function initImageTrace(dataDir: string): void {
	tracePath = join(dataDir, 'image-gen.trace.jsonl')
	try {
		mkdirSync(dirname(tracePath), { recursive: true })
	} catch {}
}

export function imageTrace(event: ImageTraceEvent): void {
	if (!tracePath) return
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		...event
	})
	try {
		appendFileSync(tracePath, line + '\n')
	} catch {
		// Intentionally silent — tracing is non-critical diagnostic output.
	}
}
