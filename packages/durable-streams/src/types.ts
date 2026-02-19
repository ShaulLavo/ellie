export interface StreamMessage {
  data: Uint8Array
  offset: string
  timestamp: number
}

export interface InternalOffset {
  readSeq: number
  byteOffset: number
}

export interface Stream {
  path: string
  contentType?: string
  messages: Array<StreamMessage>
  currentOffset: InternalOffset
  lastSeq?: string
  ttlSeconds?: number
  expiresAt?: string
  createdAt: number
  producers?: Map<string, ProducerState>
  closed?: boolean
  closedBy?: {
    producerId: string
    epoch: number
    seq: number
  }
}

export interface ProducerState {
  epoch: number
  lastSeq: number
  lastUpdated: number
}

export type ProducerValidationResult =
  | {
      status: `accepted`
      isNew: boolean
      proposedState: ProducerState
      producerId: string
    }
  | { status: `duplicate`; lastSeq: number }
  | { status: `stale_epoch`; currentEpoch: number }
  | { status: `invalid_epoch_seq` }
  | { status: `sequence_gap`; expectedSeq: number; receivedSeq: number }
  | { status: `stream_closed` }

export interface PendingLongPoll {
  path: string
  offset: string
  resolve: (messages: Array<StreamMessage>) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
  close?: boolean
}

export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
  streamClosed?: boolean
}
