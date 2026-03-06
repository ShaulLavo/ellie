/**
 * Trace runtime initialization — creates TraceRecorder and TusBlobSink.
 *
 * Called once at server startup. The recorder writes day-partitioned JSONL
 * trace journals to DATA_DIR/traces/. The blob sink writes overflow blobs
 * via the shared FileStore.
 */

import { readdirSync, rmSync, existsSync } from 'node:fs'
import { TraceRecorder, TusBlobSink } from '@ellie/trace'
import type { FileStore } from '@ellie/tus'

export interface TraceRuntime {
	recorder: TraceRecorder
	blobSink: TusBlobSink
}

/**
 * Remove legacy flat trace files (*.jsonl at the trace root, not in day subdirs).
 * These are from the old layout: data/traces/<traceId>.jsonl
 */
function cleanupFlatTraceFiles(traceDir: string): void {
	if (!existsSync(traceDir)) return
	const entries = readdirSync(traceDir)
	for (const entry of entries) {
		if (
			entry.endsWith('.jsonl') &&
			entry !== '_index.jsonl'
		) {
			rmSync(`${traceDir}/${entry}`)
			console.log(
				`[trace] removed legacy flat trace file: ${entry}`
			)
		}
	}
}

export function initTraceRuntime(
	dataDir: string,
	uploadStore: FileStore
): TraceRuntime {
	const traceDir = `${dataDir}/traces`
	const recorder = new TraceRecorder(traceDir)
	cleanupFlatTraceFiles(traceDir)
	const blobSink = new TusBlobSink(uploadStore)

	return { recorder, blobSink }
}
