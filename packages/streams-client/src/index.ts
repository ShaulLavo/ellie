/**
 * @ellie/streams-client
 *
 * Local fork of @durable-streams/client with pluggable transport support.
 * Supports both raw HTTP fetch and Elysia Treaty RPC transports.
 *
 * @packageDocumentation
 */

// ============================================================================
// Primary Read API
// ============================================================================

export { stream } from "./stream-api"

// ============================================================================
// Handle API (read/write)
// ============================================================================

export { DurableStream, type DurableStreamOptions } from "./stream"

// HTTP warning utility
export { warnIfUsingHttpInBrowser } from "./utils"

// ============================================================================
// Transport
// ============================================================================

export type {
  StreamTransport,
  TransportStreamResult,
  TransportCreateOptions,
  TransportHeadOptions,
  TransportAppendOptions,
  TransportCloseOptions,
  TransportDeleteOptions,
  TransportStreamOptions,
} from "./transport"

export {
  FetchStreamTransport,
  type FetchStreamTransportOptions,
} from "./fetch-transport"

// ============================================================================
// Idempotent Producer
// ============================================================================

export {
  IdempotentProducer,
  StaleEpochError,
  SequenceGapError,
} from "./idempotent-producer"

// ============================================================================
// Types
// ============================================================================

export type {
  // Core types
  Offset,
  HeadersRecord,
  ParamsRecord,
  MaybePromise,

  // Stream options
  StreamOptions,
  StreamHandleOptions,
  LiveMode,
  SSEResilienceOptions,

  // Chunk & batch types
  JsonBatchMeta,
  JsonBatch,
  ByteChunk,
  TextChunk,
  StreamResponse,

  // Legacy types (still used internally)
  CreateOptions,
  AppendOptions,
  ReadOptions,
  HeadResult,
  LegacyLiveMode,

  // Close types
  CloseResult,
  CloseOptions,

  // Idempotent producer types
  IdempotentProducerOptions,
  IdempotentAppendResult,

  // Error handling
  DurableStreamErrorCode,
  RetryOpts,
  StreamErrorHandler,
} from "./types"

// Re-export async iterable helper type and function
export type { ReadableStreamAsyncIterable } from "./asyncIterableReadableStream"
export { asAsyncIterableReadableStream } from "./asyncIterableReadableStream"

// ============================================================================
// Errors
// ============================================================================

export {
  FetchError,
  FetchBackoffAbortError,
  DurableStreamError,
  MissingStreamUrlError,
  InvalidSignalError,
  StreamClosedError,
} from "./error"

// ============================================================================
// Fetch utilities
// ============================================================================

export {
  type BackoffOptions,
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"

// ============================================================================
// Constants (for advanced users)
// ============================================================================

export {
  STREAM_OFFSET_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  STREAM_CLOSED_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  SSE_COMPATIBLE_CONTENT_TYPES,
  SSE_CLOSED_FIELD,
  DURABLE_STREAM_PROTOCOL_QUERY_PARAMS,
  // Idempotent producer headers
  PRODUCER_ID_HEADER,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_SEQ_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
} from "./constants"
