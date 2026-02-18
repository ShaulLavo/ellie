import { StreamStore, type CursorOptions } from "@ellie/durable-streams"

export interface ServerConfig {
  longPollTimeout: number
  compression: boolean
  cursorOptions: CursorOptions
}

export interface ServerContext {
  store: StreamStore
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
} = {}): ServerContext {
  return {
    store: new StreamStore(),
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
