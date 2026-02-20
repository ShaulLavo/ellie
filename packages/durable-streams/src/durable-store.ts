import { eq, and, lt } from "drizzle-orm"
import type { JsonlEngine } from "@ellie/db"
import { schema } from "@ellie/db"
import { StoreError } from "./errors"
import {
  normalizeContentType,
  processJsonAppend,
  formatInternalOffset,
  formatResponse,
} from "./store"
import type {
  StreamMetadata,
  StreamMessage,
  AppendOptions,
  AppendResult,
  SubscriptionEvent,
  ProducerValidationResult,
} from "./types"
import type { IStreamStore } from "./server/lib/context"

// NOTE: This store reads directly from disk on every operation with no
// in-memory message cache. It is intentionally slow — we're running this
// way for now to keep things simple and observable.
//
// TODO: Add an in-memory cache layer (e.g. LRU, Redis, or a hybrid
// write-through cache) to avoid repeated SQLite + JSONL seeks on hot streams.

const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// TODO: Replace setInterval with a proper cron job for producer cleanup
const PRODUCER_CLEANUP_INTERVAL_MS = 60 * 60_000

interface Subscription {
  path: string
  offset: string
  callback: (event: SubscriptionEvent) => void
}

type StreamRow = (typeof schema)["streams"]["$inferSelect"]

export class DurableStore implements IStreamStore {
  private engine: JsonlEngine
  private subscriptions = new Map<string, Set<Subscription>>()
  private producerLockTails = new Map<string, Promise<void>>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(engine: JsonlEngine) {
    this.engine = engine
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredProducers()
    }, PRODUCER_CLEANUP_INTERVAL_MS)
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.producerLockTails.clear()
  }

  // -- Public API (IStreamStore) --------------------------------------------

  has(path: string): boolean {
    return this.getIfNotExpired(path) !== undefined
  }

  get(path: string): StreamMetadata | undefined {
    return this.getIfNotExpired(path)
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

    this.engine.createStream(path, {
      contentType: options.contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
    })

    if (options.closed) {
      this.engine.db
        .update(schema.streams)
        .set({ closed: true })
        .where(eq(schema.streams.path, path))
        .run()
    }

    if (options.initialData && options.initialData.length > 0) {
      this.processAndAppend(path, options.initialData, options.contentType, true)
    }

    return this.get(path)!
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
          producerResult: { status: `duplicate`, lastSeq: options.producerSeq! },
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
        path,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      if (producerResult.status !== `accepted`) {
        return { message: null, producerResult }
      }
    }

    const message = this.processAndAppend(path, data, stream.contentType)

    if (producerResult && producerResult.status === `accepted`) {
      this.commitProducerState(path, producerResult)
    }

    if (options.close) {
      const updateData: Partial<StreamRow> = { closed: true }
      if (options.producerId !== undefined) {
        updateData.closedByProducerId = options.producerId
        updateData.closedByEpoch = options.producerEpoch
        updateData.closedBySeq = options.producerSeq
      }
      this.engine.db
        .update(schema.streams)
        .set(updateData)
        .where(eq(schema.streams.path, path))
        .run()
      this.notifySubscribersClosed(path)
    } else if (message) {
      this.notifySubscribers(path, message)
    }

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

  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const row = this.engine.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, path))
      .get()

    if (!row) {
      throw new StoreError(`not_found`, `Stream not found: ${path}`)
    }

    // offset === '-1' means "from beginning" (same as undefined)
    const afterOffset = !offset || offset === `-1` ? undefined : offset

    const messages = this.engine.read(path, afterOffset).map((m) => ({
      data: m.data,
      offset: m.offset,
      timestamp: m.timestamp,
    }))

    return { messages, upToDate: true }
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

    const streamOffset = formatInternalOffset(stream.currentOffset)
    if (stream.closed && offset === streamOffset) {
      queueMicrotask(() => callback({ type: `closed`, messages: [] }))
      return () => {}
    }

    const sub: Subscription = { path, offset, callback }
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

  closeStream(
    path: string
  ): { finalOffset: string; alreadyClosed: boolean } | null {
    const stream = this.getIfNotExpired(path)
    if (!stream) return null

    const alreadyClosed = stream.closed ?? false
    const finalOffset = formatInternalOffset(stream.currentOffset)

    if (!alreadyClosed) {
      this.engine.db
        .update(schema.streams)
        .set({ closed: true })
        .where(eq(schema.streams.path, path))
        .run()
      this.notifySubscribersClosed(path)
    }

    return { finalOffset, alreadyClosed }
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

      const finalOffset = formatInternalOffset(stream.currentOffset)

      if (stream.closed) {
        if (
          stream.closedBy &&
          stream.closedBy.producerId === options.producerId &&
          stream.closedBy.epoch === options.producerEpoch &&
          stream.closedBy.seq === options.producerSeq
        ) {
          return {
            finalOffset,
            alreadyClosed: true,
            producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
          }
        }
        return {
          finalOffset,
          alreadyClosed: true,
          producerResult: { status: `stream_closed` },
        }
      }

      const producerResult = this.validateProducer(
        path,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      if (producerResult.status !== `accepted`) {
        return { finalOffset, alreadyClosed: false, producerResult }
      }

      this.commitProducerState(path, producerResult)

      this.engine.db
        .update(schema.streams)
        .set({
          closed: true,
          closedByProducerId: options.producerId,
          closedByEpoch: options.producerEpoch,
          closedBySeq: options.producerSeq,
        })
        .where(eq(schema.streams.path, path))
        .run()

      this.notifySubscribersClosed(path)

      return { finalOffset, alreadyClosed: false, producerResult }
    } finally {
      releaseLock()
    }
  }

  delete(path: string): boolean {
    this.notifySubscribersDeleted(path)
    this.clearProducerLocks(path)
    this.engine.deleteStream(path)
    return true
  }

  private clearProducerLocks(path: string): void {
    const prefix = `${path}:`
    for (const key of this.producerLockTails.keys()) {
      if (key.startsWith(prefix)) {
        this.producerLockTails.delete(key)
      }
    }
  }

  formatResponse(
    contentType: string | undefined,
    messages: Array<StreamMessage>
  ): Uint8Array {
    return formatResponse(contentType, messages)
  }

  getCurrentOffset(path: string): string | undefined {
    return this.engine.getCurrentOffset(path)
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
    return this.engine.listStreams().map((r) => r.path)
  }

  // -- Private helpers -------------------------------------------------------

  private rowToStream(row: StreamRow): StreamMetadata {
    return {
      path: row.path,
      contentType: row.contentType ?? undefined,
      currentOffset: {
        readSeq: row.currentReadSeq,
        byteOffset: row.currentByteOffset,
      },
      ttlSeconds: row.ttlSeconds ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      createdAt: row.createdAt,
      closed: row.closed,
      closedBy:
        row.closedByProducerId != null
          ? {
              producerId: row.closedByProducerId,
              epoch: row.closedByEpoch!,
              seq: row.closedBySeq!,
            }
          : undefined,
    }
  }

  private isExpired(row: StreamRow): boolean {
    const now = Date.now()

    if (row.expiresAt) {
      const expiryTime = new Date(row.expiresAt).getTime()
      if (!Number.isFinite(expiryTime) || now >= expiryTime) return true
    }

    if (row.ttlSeconds !== null && row.ttlSeconds !== undefined) {
      const expiryTime = row.createdAt + row.ttlSeconds * 1000
      if (now >= expiryTime) return true
    }

    return false
  }

  private getIfNotExpired(path: string): StreamMetadata | undefined {
    const row = this.engine.getStream(path)
    if (!row) return undefined
    if (this.isExpired(row)) {
      this.delete(path)
      return undefined
    }
    return this.rowToStream(row)
  }

  private processAndAppend(
    path: string,
    data: Uint8Array,
    contentType: string | undefined,
    isInitialCreate = false
  ): StreamMessage | null {
    let processedData = data
    if (normalizeContentType(contentType) === `application/json`) {
      processedData = processJsonAppend(data, isInitialCreate)
      if (processedData.length === 0) return null
    }

    const result = this.engine.append(path, processedData)

    return {
      data: processedData,
      offset: result.offset,
      timestamp: result.timestamp,
    }
  }

  private validateProducer(
    path: string,
    producerId: string,
    epoch: number,
    seq: number
  ): ProducerValidationResult {
    const now = Date.now()

    const state = this.engine.db
      .select()
      .from(schema.producers)
      .where(
        and(
          eq(schema.producers.streamPath, path),
          eq(schema.producers.producerId, producerId)
        )
      )
      .get()

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
    path: string,
    result: ProducerValidationResult
  ): void {
    if (result.status !== `accepted`) return

    const { producerId, proposedState } = result

    this.engine.db
      .insert(schema.producers)
      .values({
        streamPath: path,
        producerId,
        epoch: proposedState.epoch,
        lastSeq: proposedState.lastSeq,
        lastUpdated: proposedState.lastUpdated,
      })
      .onConflictDoUpdate({
        target: [schema.producers.streamPath, schema.producers.producerId],
        set: {
          epoch: proposedState.epoch,
          lastSeq: proposedState.lastSeq,
          lastUpdated: proposedState.lastUpdated,
        },
      })
      .run()
  }

  private cleanupExpiredProducers(): void {
    this.engine.db
      .delete(schema.producers)
      .where(lt(schema.producers.lastUpdated, Date.now() - PRODUCER_STATE_TTL_MS))
      .run()
  }

  private acquireProducerLock(
    path: string,
    producerId: string
  ): Promise<() => void> {
    const lockKey = `${path}:${producerId}`
    const previousTail =
      this.producerLockTails.get(lockKey) ?? Promise.resolve()

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
