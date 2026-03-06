/**
 * Core types for the canonical trace journal.
 *
 * Every runtime operation (model call, tool execution, memory operation,
 * REPL activity) is recorded as a TraceEventEnvelope in an append-only
 * JSONL journal. Large payloads are stored as TUS-backed blobs via BlobRef.
 */

// ============================================================================
// Trace event envelope
// ============================================================================

/**
 * Canonical envelope for every trace event. Written to JSONL.
 *
 * Required fields ensure every event is attributable to a trace tree
 * and ordered within its trace.
 */
export interface TraceEventEnvelope {
	/** Unique event identifier (ULID). */
	eventId: string
	/** Root trace identifier (ULID). */
	traceId: string
	/** Current span identifier (ULID). */
	spanId: string
	/** Parent span — undefined for root spans. */
	parentSpanId?: string
	/** Session this trace belongs to, if any. */
	sessionId?: string
	/** Agent run this trace belongs to, if any. */
	runId?: string
	/** Event kind — e.g. 'prompt.snapshot', 'tool.start', 'model.request'. */
	kind: string
	/** Timestamp (Date.now()). */
	ts: number
	/** Monotonic sequence number within this trace. */
	seq: number
	/** Subsystem that produced this event — 'model', 'tool', 'memory', 'repl', 'controller'. */
	component: string
	/** Kind-specific payload data. */
	payload: unknown
	/** Blob references attached to this event. */
	blobRefs?: BlobRef[]
}

// ============================================================================
// Blob reference
// ============================================================================

/**
 * Pointer to a TUS-stored blob. The `uploadId` is the canonical identity.
 */
export interface BlobRef {
	/** TUS upload ID — canonical blob identity. */
	uploadId: string
	/** Internal storage path: trace/<traceId>/<spanId>/<role>/<ulid>.<ext> */
	storagePath: string
	/** MIME type of the blob content. */
	mimeType: string
	/** Size of the blob in bytes. */
	sizeBytes: number
	/** ohash fingerprint for deduplication and display. */
	ohash: string
	/** Semantic role — 'tool_result_full', 'prompt_snapshot', 'model_response', etc. */
	role: string
	/** Truncated preview for inline display (optional). */
	preview?: string
}

// ============================================================================
// Blob sink
// ============================================================================

/** Options for writing a blob. */
export interface BlobWriteOptions {
	traceId: string
	spanId: string
	/** Semantic role — used as part of the storage path. */
	role: string
	/** Content to store. */
	content: string | Buffer
	/** MIME type. */
	mimeType: string
	/** File extension (without leading dot). */
	ext: string
}

/**
 * Interface for writing blobs to TUS-backed storage.
 *
 * Implementations MUST throw on failure (fail-closed).
 * No silent swallowing of write errors.
 */
export interface BlobSink {
	write(opts: BlobWriteOptions): Promise<BlobRef>
}

// ============================================================================
// Trace scope
// ============================================================================

/**
 * Immutable bag of propagation context for a trace span.
 *
 * Passed explicitly through function parameters — no AsyncLocalStorage.
 */
export interface TraceScope {
	traceId: string
	spanId: string
	parentSpanId?: string
	sessionId?: string
	runId?: string
}
