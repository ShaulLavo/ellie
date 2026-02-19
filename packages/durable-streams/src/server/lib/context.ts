import { StreamStore } from "../../store"
import type { CursorOptions } from "../../cursor"
import type {
  Stream,
  StreamMessage,
  AppendOptions,
  AppendResult,
  SubscriptionEvent,
  ProducerValidationResult,
} from "../../types"

// Minimal interface that all stream store implementations must satisfy.
// Route handlers only call these methods — allows DurableStore and StreamStore
// to be used interchangeably without sharing a class hierarchy.
export interface IStreamStore {
  has(path: string): boolean
  get(path: string): Stream | undefined
  create(
    path: string,
    options?: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
    }
  ): Stream
  append(path: string, data: Uint8Array, options?: AppendOptions): AppendResult
  appendWithProducer(
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult>
  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean }
  subscribe(
    path: string,
    offset: string,
    callback: (event: SubscriptionEvent) => void
  ): () => void
  closeStream(
    path: string
  ): { finalOffset: string; alreadyClosed: boolean } | null
  closeStreamWithProducer(
    path: string,
    options: { producerId: string; producerEpoch: number; producerSeq: number }
  ): Promise<{
    finalOffset: string
    alreadyClosed: boolean
    producerResult?: ProducerValidationResult
  } | null>
  delete(path: string): boolean
  formatResponse(
    contentType: string | undefined,
    messages: Array<StreamMessage>
  ): Uint8Array
  getCurrentOffset(path: string): string | undefined
  cancelAllSubscriptions(): void
  list(): Array<string>
}

export interface ServerConfig {
  longPollTimeout: number
  compression: boolean
  cursorOptions: CursorOptions
}

export interface ServerContext {
  store: IStreamStore
  config: ServerConfig
  activeSSEResponses: Set<ReadableStreamDefaultController>
  isShuttingDown: boolean
  injectedFaults: Map<string, InjectedFault>
}

export interface InjectedFault {
  status?: number
  count: number
  retryAfter?: number
  delayMs?: number
  dropConnection?: boolean
  truncateBodyBytes?: number
  probability?: number
  method?: string
  corruptBody?: boolean
  jitterMs?: number
  injectSseEvent?: {
    eventType: string
    data: string
  }
}

export function createServerContext(options: {
  longPollTimeout?: number
  compression?: boolean
  cursorOptions?: CursorOptions
  store?: IStreamStore
} = {}): ServerContext {
  return {
    store: options.store ?? new StreamStore(),
    config: {
      longPollTimeout: options.longPollTimeout ?? 30_000,
      compression: options.compression ?? true,
      cursorOptions: options.cursorOptions ?? {},
    },
    activeSSEResponses: new Set(),
    isShuttingDown: false,
    injectedFaults: new Map(),
  }
}

/**
 * Gracefully shut down a server context: cancel subscriptions,
 * close all active SSE responses, and mark the context as shutting down.
 */
export function shutdown(ctx: ServerContext): void {
  ctx.isShuttingDown = true
  ctx.store.cancelAllSubscriptions()
  ctx.activeSSEResponses.forEach((controller) => {
    try {
      controller.close()
    } catch {
      // Already closed
    }
  })
  ctx.activeSSEResponses.clear()
}

export function consumeInjectedFault(
  ctx: ServerContext,
  path: string,
  method: string
): InjectedFault | null {
  const fault = ctx.injectedFaults.get(path)
  if (!fault) return null

  if (fault.method && fault.method.toUpperCase() !== method.toUpperCase()) {
    return null
  }

  if (fault.probability !== undefined && Math.random() > fault.probability) {
    return null
  }

  fault.count--
  if (fault.count <= 0) {
    ctx.injectedFaults.delete(path)
  }

  return fault
}
