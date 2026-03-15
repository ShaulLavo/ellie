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
