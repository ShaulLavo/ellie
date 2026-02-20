import type {
  AppendOptions,
  AppendResult,
  InternalOffset,
  SubscriptionEvent,
  ProducerValidationResult,
  Stream,
  StreamMetadata,
  StreamMessage,
} from "./types"
import { StoreError } from "./errors"

const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function formatOffset(readSeq: number, byteOffset: number): string {
  return `${String(readSeq).padStart(16, `0`)}_${String(byteOffset).padStart(16, `0`)}`
}

export function formatInternalOffset(offset: InternalOffset): string {
  return formatOffset(offset.readSeq, offset.byteOffset)
}

export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

export function processJsonAppend(
  data: Uint8Array,
  isInitialCreate = false
): Uint8Array {
  const text = decoder.decode(data)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StoreError(`invalid_json`, `Invalid JSON`)
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      if (isInitialCreate) {
        return new Uint8Array(0)
      }
      throw new StoreError(`empty_array`, `Empty arrays are not allowed`)
    }
    // Arrays must be split into individual messages — stringify each element
    const elements = parsed.map((item) => JSON.stringify(item))
    const result = elements.join(`,`) + `,`
    return encoder.encode(result)
  }

  // Single value: validation passed above, append comma byte to raw bytes.
  // Avoids stringify round-trip and preserves original formatting.
  const out = new Uint8Array(data.length + 1)
  out.set(data)
  out[data.length] = 0x2c // comma
  return out
}

export function formatJsonResponse(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    return encoder.encode(`[]`)
  }

  let text = decoder.decode(data)
  text = text.trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }

  const wrapped = `[${text}]`
  return encoder.encode(wrapped)
}

/**
 * Build a JSON array response directly from message data into a single buffer.
 * Avoids the decode → string ops → re-encode round-trip of formatJsonResponse.
 * Each message's data is comma-terminated (from processJsonAppend).
 * Output: [msg1,msg2,...,msgN] with the last comma replaced by ']'.
 */
export function formatJsonResponseDirect(messages: Array<StreamMessage>): Uint8Array {
  if (messages.length === 0) {
    return encoder.encode(`[]`)
  }

  // Total: '[' (1 byte) + all message data bytes (already comma-terminated)
  // The last comma gets replaced with ']', so total size = 1 + totalDataSize
  let totalDataSize = 0
  for (const msg of messages) {
    totalDataSize += msg.data.length
  }

  const result = new Uint8Array(1 + totalDataSize)
  result[0] = 0x5b // '['

  let offset = 1
  for (const msg of messages) {
    result.set(msg.data, offset)
    offset += msg.data.length
  }

  // Replace trailing comma with ']'. Trim trailing whitespace first.
  let end = offset
  while (end > 1 && (result[end - 1] === 0x20 || result[end - 1] === 0x0a || result[end - 1] === 0x0d || result[end - 1] === 0x09)) {
    end--
  }
  if (end > 1 && result[end - 1] === 0x2c) {
    result[end - 1] = 0x5d // ']'
    return end < result.length ? result.subarray(0, end) : result
  }

  // Fallback: no trailing comma found, append ']'
  const withBracket = new Uint8Array(offset + 1)
  withBracket.set(result.subarray(0, offset))
  withBracket[offset] = 0x5d // ']'
  return withBracket
}

/**
 * Lightweight JSON format for a single message's raw data.
 * Avoids the allocations of formatResponse (no getIfNotExpired,
 * no Uint8Array concatenation, no decode/trim/re-encode round-trip).
 *
 * Expects `data` to already be in the internal comma-terminated JSON
 * format produced by processJsonAppend (e.g. `{"foo":1},`).
 * Returns the string `[{"foo":1}]` suitable for SSE data payload.
 */
export function formatSingleJsonMessage(data: Uint8Array): string {
  // Fast path: strip trailing comma directly from bytes
  let end = data.length
  // trim trailing whitespace
  while (end > 0 && (data[end - 1] === 0x20 || data[end - 1] === 0x0a || data[end - 1] === 0x0d || data[end - 1] === 0x09)) {
    end--
  }
  // strip trailing comma (0x2c)
  if (end > 0 && data[end - 1] === 0x2c) {
    end--
  }

  // Decode only the needed portion and wrap
  const inner = decoder.decode(end === data.length ? data : data.subarray(0, end))
  return `[${inner}]`
}

export function formatResponse(contentType: string | undefined, messages: Array<StreamMessage>): Uint8Array {
  if (normalizeContentType(contentType) === `application/json`) {
    return formatJsonResponseDirect(messages)
  }

  // Binary: concatenate all message data
  const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const msg of messages) {
    result.set(msg.data, offset)
    offset += msg.data.length
  }
  return result
}

interface Subscription {
  path: string
  offset: string
  callback: (event: SubscriptionEvent) => void
}

export class StreamStore {
  private streams = new Map<string, Stream>()
  private subscriptions = new Map<string, Set<Subscription>>()
  private producerLockTails = new Map<string, Promise<void>>()

  private isExpired(stream: Stream): boolean {
    const now = Date.now()

    if (stream.expiresAt) {
      const expiryTime = new Date(stream.expiresAt).getTime()
      if (!Number.isFinite(expiryTime) || now >= expiryTime) {
        return true
      }
    }

    if (stream.ttlSeconds !== undefined) {
      const expiryTime = stream.createdAt + stream.ttlSeconds * 1000
      if (now >= expiryTime) {
        return true
      }
    }

    return false
  }

  private getIfNotExpired(path: string): Stream | undefined {
    const stream = this.streams.get(path)
    if (!stream) return undefined
    if (this.isExpired(stream)) {
      this.delete(path)
      return undefined
    }
    return stream
  }

  create(
    path: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
    } = {}
  ): StreamMetadata {
    const existing = this.getIfNotExpired(path)
    if (existing) {
      const newContentType =
        normalizeContentType(options.contentType) || `application/octet-stream`
      const existingContentType =
        normalizeContentType(existing.contentType) || `application/octet-stream`
      const contentTypeMatches = newContentType === existingContentType
      const ttlMatches = options.ttlSeconds === existing.ttlSeconds
      const expiresMatches = options.expiresAt === existing.expiresAt
      const newClosed = options.closed ?? false
      const existingClosed = existing.closed ?? false
      const closedMatches = newClosed === existingClosed

      if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches) {
        return existing
      } else {
        throw new StoreError(
          `already_exists`,
          `Stream already exists with different configuration: ${path}`
        )
      }
    }

    const stream: Stream = {
      path,
      contentType: options.contentType,
      messages: [],
      currentOffset: { readSeq: 0, byteOffset: 0 },
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
      closed: options.closed ?? false,
    }

    if (options.initialData && options.initialData.length > 0) {
      this.appendToStream(stream, options.initialData, true)
    }

    this.streams.set(path, stream)
    return stream
  }

  get(path: string): StreamMetadata | undefined {
    return this.getIfNotExpired(path)
  }

  has(path: string): boolean {
    return this.getIfNotExpired(path) !== undefined
  }

  delete(path: string): boolean {
    this.notifySubscribersDeleted(path)
    this.clearProducerLocks(path)
    return this.streams.delete(path)
  }

  private clearProducerLocks(path: string): void {
    const prefix = `${path}:`
    for (const key of this.producerLockTails.keys()) {
      if (key.startsWith(prefix)) {
        this.producerLockTails.delete(key)
      }
    }
  }

  private validateProducer(
    stream: Stream,
    producerId: string,
    epoch: number,
    seq: number
  ): ProducerValidationResult {
    if (!stream.producers) {
      stream.producers = new Map()
    }

    this.cleanupExpiredProducers(stream)

    const state = stream.producers.get(producerId)
    const now = Date.now()

    if (!state) {
      if (seq !== 0) {
        return { status: `sequence_gap`, expectedSeq: 0, receivedSeq: seq }
      }
      return {
        status: `accepted`,
        isNew: true,
        producerId,
        proposedState: { epoch, lastSeq: 0, lastUpdated: now },
      }
    }

    if (epoch < state.epoch) {
      return { status: `stale_epoch`, currentEpoch: state.epoch }
    }

    if (epoch > state.epoch) {
      if (seq !== 0) {
        return { status: `invalid_epoch_seq` }
      }
      return {
        status: `accepted`,
        isNew: true,
        producerId,
        proposedState: { epoch, lastSeq: 0, lastUpdated: now },
      }
    }

    if (seq <= state.lastSeq) {
      return { status: `duplicate`, lastSeq: state.lastSeq }
    }

    if (seq === state.lastSeq + 1) {
      return {
        status: `accepted`,
        isNew: false,
        producerId,
        proposedState: { epoch, lastSeq: seq, lastUpdated: now },
      }
    }

    return {
      status: `sequence_gap`,
      expectedSeq: state.lastSeq + 1,
      receivedSeq: seq,
    }
  }

  private commitProducerState(
    stream: Stream,
    result: ProducerValidationResult
  ): void {
    if (result.status !== `accepted`) return
    stream.producers!.set(result.producerId, result.proposedState)
  }

  private cleanupExpiredProducers(stream: Stream): void {
    if (!stream.producers) return
    const now = Date.now()
    for (const [id, state] of stream.producers) {
      if (now - state.lastUpdated > PRODUCER_STATE_TTL_MS) {
        stream.producers.delete(id)
      }
    }
  }

  private acquireProducerLock(
    path: string,
    producerId: string
  ): Promise<() => void> {
    const lockKey = `${path}:${producerId}`
    const previousTail = this.producerLockTails.get(lockKey) ?? Promise.resolve()

    let releaseLock!: () => void
    const newTail = new Promise<void>((resolve) => {
      releaseLock = () => {
        if (this.producerLockTails.get(lockKey) === newTail) {
          this.producerLockTails.delete(lockKey)
        }
        resolve()
      }
    })

    this.producerLockTails.set(lockKey, newTail)

    return previousTail.then(() => releaseLock)
  }

  append(
    path: string,
    data: Uint8Array,
    options: AppendOptions = {}
  ): AppendResult {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StoreError(`not_found`, `Stream not found: ${path}`)
    }

    if (stream.closed) {
      if (
        options.producerId &&
        stream.closedBy &&
        stream.closedBy.producerId === options.producerId &&
        stream.closedBy.epoch === options.producerEpoch &&
        stream.closedBy.seq === options.producerSeq
      ) {
        return {
          message: null,
          streamClosed: true,
          producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
        }
      }
      return { message: null, streamClosed: true }
    }

    if (options.contentType && stream.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(stream.contentType)
      if (providedType !== streamType) {
        throw new StoreError(
          `content_type_mismatch`,
          `Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`
        )
      }
    }

    let producerResult: ProducerValidationResult | undefined
    if (
      options.producerId !== undefined &&
      options.producerEpoch !== undefined &&
      options.producerSeq !== undefined
    ) {
      producerResult = this.validateProducer(
        stream,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      if (producerResult.status !== `accepted`) {
        return { message: null, producerResult }
      }
    }

    if (options.seq !== undefined) {
      if (stream.lastSeq !== undefined && options.seq <= stream.lastSeq) {
        throw new StoreError(
          `sequence_conflict`,
          `Sequence conflict: ${options.seq} <= ${stream.lastSeq}`
        )
      }
    }

    const message = this.appendToStream(stream, data)!

    if (producerResult) {
      this.commitProducerState(stream, producerResult)
    }

    if (options.seq !== undefined) {
      stream.lastSeq = options.seq
    }

    if (options.close) {
      stream.closed = true
      if (options.producerId !== undefined) {
        stream.closedBy = {
          producerId: options.producerId,
          epoch: options.producerEpoch!,
          seq: options.producerSeq!,
        }
      }
      this.notifySubscribersClosed(path)
    }

    this.notifySubscribers(path, message)

    return { message, producerResult, streamClosed: options.close }
  }

  async appendWithProducer(
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult> {
    if (!options.producerId) {
      return this.append(path, data, options)
    }

    const releaseLock = await this.acquireProducerLock(path, options.producerId)
    try {
      return this.append(path, data, options)
    } finally {
      releaseLock()
    }
  }

  closeStream(
    path: string
  ): { finalOffset: string; alreadyClosed: boolean } | null {
    const stream = this.getIfNotExpired(path)
    if (!stream) return null

    const alreadyClosed = stream.closed ?? false
    stream.closed = true
    this.notifySubscribersClosed(path)

    return { finalOffset: formatInternalOffset(stream.currentOffset), alreadyClosed }
  }

  async closeStreamWithProducer(
    path: string,
    options: {
      producerId: string
      producerEpoch: number
      producerSeq: number
    }
  ): Promise<{
    finalOffset: string
    alreadyClosed: boolean
    producerResult?: ProducerValidationResult
  } | null> {
    const releaseLock = await this.acquireProducerLock(path, options.producerId)

    try {
      const stream = this.getIfNotExpired(path)
      if (!stream) return null

      if (stream.closed) {
        if (
          stream.closedBy &&
          stream.closedBy.producerId === options.producerId &&
          stream.closedBy.epoch === options.producerEpoch &&
          stream.closedBy.seq === options.producerSeq
        ) {
          return {
            finalOffset: formatInternalOffset(stream.currentOffset),
            alreadyClosed: true,
            producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
          }
        }

        return {
          finalOffset: formatInternalOffset(stream.currentOffset),
          alreadyClosed: true,
          producerResult: { status: `stream_closed` },
        }
      }

      const producerResult = this.validateProducer(
        stream,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      if (producerResult.status !== `accepted`) {
        return {
          finalOffset: formatInternalOffset(stream.currentOffset),
          alreadyClosed: stream.closed ?? false,
          producerResult,
        }
      }

      this.commitProducerState(stream, producerResult)
      stream.closed = true
      stream.closedBy = {
        producerId: options.producerId,
        epoch: options.producerEpoch,
        seq: options.producerSeq,
      }

      this.notifySubscribersClosed(path)

      return {
        finalOffset: formatInternalOffset(stream.currentOffset),
        alreadyClosed: false,
        producerResult,
      }
    } finally {
      releaseLock()
    }
  }

  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StoreError(`not_found`, `Stream not found: ${path}`)
    }

    if (!offset || offset === `-1`) {
      return { messages: stream.messages, upToDate: true }
    }

    const offsetIndex = this.findOffsetIndex(stream, offset)
    if (offsetIndex === -1) {
      return { messages: [], upToDate: true }
    }

    return { messages: stream.messages.slice(offsetIndex), upToDate: true }
  }

  formatResponse(contentType: string | undefined, messages: Array<StreamMessage>): Uint8Array {
    return formatResponse(contentType, messages)
  }

  subscribe(
    path: string,
    offset: string,
    callback: (event: SubscriptionEvent) => void
  ): () => void {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StoreError(`not_found`, `Stream not found: ${path}`)
    }

    const { messages } = this.read(path, offset)
    if (messages.length > 0) {
      queueMicrotask(() => callback({ type: `messages`, messages }))
      return () => {}
    }

    if (stream.closed && offset === formatInternalOffset(stream.currentOffset)) {
      queueMicrotask(() => callback({ type: `closed`, messages: [] }))
      return () => {}
    }

    const sub = { path, offset, callback }
    let set = this.subscriptions.get(path)
    if (!set) {
      set = new Set()
      this.subscriptions.set(path, set)
    }
    set.add(sub)

    return () => {
      const s = this.subscriptions.get(path)
      if (s) {
        s.delete(sub)
        if (s.size === 0) {
          this.subscriptions.delete(path)
        }
      }
    }
  }

  getCurrentOffset(path: string): string | undefined {
    const stream = this.getIfNotExpired(path)
    return stream ? formatInternalOffset(stream.currentOffset) : undefined
  }

  clear(): void {
    for (const set of this.subscriptions.values()) {
      for (const sub of set) {
        sub.callback({ type: `deleted`, messages: [] })
      }
    }
    this.subscriptions.clear()
    this.streams.clear()
  }

  cancelAllSubscriptions(): void {
    for (const set of this.subscriptions.values()) {
      for (const sub of set) {
        sub.callback({ type: `deleted`, messages: [] })
      }
    }
    this.subscriptions.clear()
  }

  list(): Array<string> {
    return Array.from(this.streams.keys())
  }

  // Private helpers

  private appendToStream(
    stream: Stream,
    data: Uint8Array,
    isInitialCreate = false
  ): StreamMessage | null {
    let processedData = data
    if (normalizeContentType(stream.contentType) === `application/json`) {
      processedData = processJsonAppend(data, isInitialCreate)
      if (processedData.length === 0) return null
    }

    const newByteOffset = stream.currentOffset.byteOffset + processedData.length
    const newOffset = formatOffset(stream.currentOffset.readSeq, newByteOffset)

    const message: StreamMessage = {
      data: processedData,
      offset: newOffset,
      timestamp: Date.now(),
    }

    stream.messages.push(message)
    stream.currentOffset = { readSeq: stream.currentOffset.readSeq, byteOffset: newByteOffset }

    return message
  }

  private findOffsetIndex(stream: Stream, offset: string): number {
    const messages = stream.messages
    let lo = 0
    let hi = messages.length

    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (messages[mid]!.offset > offset) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }

    return lo < messages.length ? lo : -1
  }

  private notifySubscribers(path: string, newMessage: StreamMessage): void {
    const set = this.subscriptions.get(path)
    if (!set || set.size === 0) return

    const toNotify: Subscription[] = []
    for (const sub of set) {
      if (newMessage.offset > sub.offset) {
        toNotify.push(sub)
      }
    }

    if (toNotify.length === 0) return

    for (const sub of toNotify) {
      set.delete(sub)
    }
    if (set.size === 0) {
      this.subscriptions.delete(path)
    }

    const messages = [newMessage]
    for (const sub of toNotify) {
      sub.callback({ type: `messages`, messages })
    }
  }

  private notifySubscribersClosed(path: string): void {
    const set = this.subscriptions.get(path)
    if (!set || set.size === 0) return

    const toNotify = Array.from(set)
    set.clear()
    this.subscriptions.delete(path)

    for (const sub of toNotify) {
      sub.callback({ type: `closed`, messages: [] })
    }
  }

  private notifySubscribersDeleted(path: string): void {
    const set = this.subscriptions.get(path)
    if (!set) return

    const toNotify = Array.from(set)
    this.subscriptions.delete(path)

    for (const sub of toNotify) {
      sub.callback({ type: `deleted`, messages: [] })
    }
  }
}
