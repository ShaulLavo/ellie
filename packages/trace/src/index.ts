// Core types
export type {
	TraceEventEnvelope,
	BlobRef,
	BlobSink,
	BlobWriteOptions,
	TraceScope
} from './types'

// Scope factories
export { createRootScope, createChildScope } from './scope'

// Blob sink
export {
	TusBlobSink,
	BLOB_THRESHOLD,
	shouldBlob
} from './blob-sink'

// Recorder
export { TraceRecorder } from './recorder'

// Traced facades
export {
	createTracedStreamFn,
	createTracedToolWrapper,
	wrapMemoryOrchestrator,
	createTracedReplTool,
	type TracedModelOptions,
	type TracedToolOptions,
	type TracedMemoryOptions,
	type TracedReplOptions
} from './facades'

// Projector
export {
	projectTraceToEvents,
	type ProjectedEvent
} from './projector'
