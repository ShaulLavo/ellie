/**
 * Trace runtime initialization — creates TraceRecorder and TusBlobSink.
 *
 * Called once at server startup. The recorder writes JSONL trace journals
 * to DATA_DIR/traces/. The blob sink writes overflow blobs via the
 * shared FileStore.
 */

import { TraceRecorder, TusBlobSink } from '@ellie/trace'
import type { FileStore } from '@ellie/tus'

export interface TraceRuntime {
	recorder: TraceRecorder
	blobSink: TusBlobSink
}

export function initTraceRuntime(
	dataDir: string,
	uploadStore: FileStore
): TraceRuntime {
	const traceDir = `${dataDir}/traces`
	const recorder = new TraceRecorder(traceDir)
	const blobSink = new TusBlobSink(uploadStore)

	return { recorder, blobSink }
}
