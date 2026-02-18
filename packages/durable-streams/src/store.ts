import type {
  AppendOptions,
  AppendResult,
  PendingLongPoll,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "./types"

const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

export function processJsonAppend(
  data: Uint8Array,
  isInitialCreate = false
): Uint8Array {
  const text = new TextDecoder().decode(data)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON`)
  }

  let result: string
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      if (isInitialCreate) {
        return new Uint8Array(0)
      }
      throw new Error(`Empty arrays are not allowed`)
    }
    const elements = parsed.map((item) => JSON.stringify(item))
    result = elements.join(`,`) + `,`
  } else {
    result = JSON.stringify(parsed) + `,`
  }

  return new TextEncoder().encode(result)
}

export function formatJsonResponse(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    return new TextEncoder().encode(`[]`)
  }

  let text = new TextDecoder().decode(data)
  text = text.trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }

  const wrapped = `[${text}]`
  return new TextEncoder().encode(wrapped)
}

export class StreamStore {
  private streams = new Map<string, Stream>()
  private pendingLongPolls: Array<PendingLongPoll> = []
  private producerLocks = new Map<string, Promise<unknown>>()

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
  ): Stream {
    const existing = this.getIfNotExpired(path)
    if (existing) {
      const contentTypeMatches =
        (normalizeContentType(options.contentType) ||
          `application/octet-stream`) ===
        (normalizeContentType(existing.contentType) ||
          `application/octet-stream`)
      const ttlMatches = options.ttlSeconds === existing.ttlSeconds
      const expiresMatches = options.expiresAt === existing.expiresAt
      const closedMatches =
        (options.closed ?? false) === (existing.closed ?? false)

      if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches) {
        return existing
      } else {
        throw new Error(
          `Stream already exists with different configuration: ${path}`
        )
      }
    }

    const stream: Stream = {
      path,
      contentType: options.contentType,
      messages: [],
      currentOffset: `0000000000000000_0000000000000000`,
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

  get(path: string): Stream | undefined {
    return this.getIfNotExpired(path)
  }

  has(path: string): boolean {
    return this.getIfNotExpired(path) !== undefined
  }

  delete(path: string): boolean {
    this.cancelLongPollsForStream(path)
    return this.streams.delete(path)
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

  private async acquireProducerLock(
    path: string,
    producerId: string
  ): Promise<() => void> {
    const lockKey = `${path}:${producerId}`

    while (this.producerLocks.has(lockKey)) {
      await this.producerLocks.get(lockKey)
    }

    let releaseLock: () => void
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    this.producerLocks.set(lockKey, lockPromise)

    return () => {
      this.producerLocks.delete(lockKey)
      releaseLock!()
    }
  }

  append(
    path: string,
    data: Uint8Array,
    options: AppendOptions = {}
  ): StreamMessage | AppendResult {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
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
        throw new Error(
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
        throw new Error(
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
      this.notifyLongPollsClosed(path)
    }

    this.notifyLongPolls(path)

    if (producerResult || options.close) {
      return { message, producerResult, streamClosed: options.close }
    }

    return message
  }

  async appendWithProducer(
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult> {
    if (!options.producerId) {
      const result = this.append(path, data, options)
      if (`message` in result) return result
      return { message: result }
    }

    const releaseLock = await this.acquireProducerLock(path, options.producerId)
    try {
      const result = this.append(path, data, options)
      if (`message` in result) return result
      return { message: result }
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
    this.notifyLongPollsClosed(path)

    return { finalOffset: stream.currentOffset, alreadyClosed }
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
            finalOffset: stream.currentOffset,
            alreadyClosed: true,
            producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
          }
        }

        return {
          finalOffset: stream.currentOffset,
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
          finalOffset: stream.currentOffset,
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

      this.notifyLongPollsClosed(path)

      return {
        finalOffset: stream.currentOffset,
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
      throw new Error(`Stream not found: ${path}`)
    }

    if (!offset || offset === `-1`) {
      return { messages: [...stream.messages], upToDate: true }
    }

    const offsetIndex = this.findOffsetIndex(stream, offset)
    if (offsetIndex === -1) {
      return { messages: [], upToDate: true }
    }

    return { messages: stream.messages.slice(offsetIndex), upToDate: true }
  }

  formatResponse(path: string, messages: Array<StreamMessage>): Uint8Array {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
    const concatenated = new Uint8Array(totalSize)
    let offset = 0
    for (const msg of messages) {
      concatenated.set(msg.data, offset)
      offset += msg.data.length
    }

    if (normalizeContentType(stream.contentType) === `application/json`) {
      return formatJsonResponse(concatenated)
    }

    return concatenated
  }

  async waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{
    messages: Array<StreamMessage>
    timedOut: boolean
    streamClosed?: boolean
  }> {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    const { messages } = this.read(path, offset)
    if (messages.length > 0) {
      return { messages, timedOut: false }
    }

    if (stream.closed && offset === stream.currentOffset) {
      return { messages: [], timedOut: false, streamClosed: true }
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.removePendingLongPoll(pending)
        const currentStream = this.getIfNotExpired(path)
        const streamClosed = currentStream?.closed ?? false
        resolve({ messages: [], timedOut: true, streamClosed })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          this.removePendingLongPoll(pending)
          const currentStream = this.getIfNotExpired(path)
          const streamClosed =
            currentStream?.closed && msgs.length === 0 ? true : undefined
          resolve({ messages: msgs, timedOut: false, streamClosed })
        },
        timeoutId,
      }

      this.pendingLongPolls.push(pending)
    })
  }

  getCurrentOffset(path: string): string | undefined {
    return this.getIfNotExpired(path)?.currentOffset
  }

  clear(): void {
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      pending.resolve([])
    }
    this.pendingLongPolls = []
    this.streams.clear()
  }

  cancelAllWaits(): void {
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      pending.resolve([])
    }
    this.pendingLongPolls = []
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

    const parts = stream.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    const newByteOffset = byteOffset + processedData.length
    const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`

    const message: StreamMessage = {
      data: processedData,
      offset: newOffset,
      timestamp: Date.now(),
    }

    stream.messages.push(message)
    stream.currentOffset = newOffset

    return message
  }

  private findOffsetIndex(stream: Stream, offset: string): number {
    for (let i = 0; i < stream.messages.length; i++) {
      if (stream.messages[i]!.offset > offset) return i
    }
    return -1
  }

  private notifyLongPolls(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toNotify) {
      const { messages } = this.read(path, pending.offset)
      if (messages.length > 0) {
        pending.resolve(messages)
      }
    }
  }

  private notifyLongPollsClosed(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toNotify) {
      pending.resolve([])
    }
  }

  private cancelLongPollsForStream(path: string): void {
    const toCancel = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toCancel) {
      clearTimeout(pending.timeoutId)
      pending.resolve([])
    }
    this.pendingLongPolls = this.pendingLongPolls.filter((p) => p.path !== path)
  }

  private removePendingLongPoll(pending: PendingLongPoll): void {
    const index = this.pendingLongPolls.indexOf(pending)
    if (index !== -1) {
      this.pendingLongPolls.splice(index, 1)
    }
  }
}
