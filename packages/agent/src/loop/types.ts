import type { EventStream } from '../event-stream'
import type { ToolLoopDetector } from '../tool-loop-detection'
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	StreamFn,
	ToolResultMessage
} from '../types'

export type EmitFn = (event: AgentEvent) => void

export interface ProcessResult {
	messages: AgentMessage[]
	toolResults: ToolResultMessage[]
	lastAssistant: AssistantMessage
	abortedOrError: boolean
}

export interface GuardrailState {
	startedAtMs: number
	modelCallCount: number
	costUsd: number
	limitTriggered: boolean
}

// ---------------------------------------------------------------------------
// Context objects — group related parameters to reduce function arity
// ---------------------------------------------------------------------------

/**
 * Context for stream-level functions (processAgentStream,
 * processAgentStreamWithRetry).  Contains only what the LLM
 * streaming layer needs — no run-level state like newMessages
 * or the EventStream terminator.
 *
 * `signal` is the *effective* signal (may include wall-clock
 * timeout) that stream processing and retry logic should respect.
 */
export interface StreamContext {
	currentContext: AgentContext
	config: AgentLoopConfig
	signal: AbortSignal | undefined
	emit: EmitFn
	streamFn?: StreamFn
	loopDetector?: ToolLoopDetector
}

/**
 * Full context for the outer run-loop layer.  Extends StreamContext
 * with the per-run mutable state (newMessages, stream terminator,
 * guardrail state) that the outer loop needs.
 *
 * `signal` here is the effective (guarded) signal.  `userSignal`
 * preserves the original caller-provided signal so that
 * `handleAbortOrError` can distinguish wall-clock timeouts from
 * user-initiated aborts.
 */
export interface RunContext extends StreamContext {
	newMessages: AgentMessage[]
	stream: EventStream<AgentEvent, AgentMessage[]>
	guardrailState: GuardrailState
	loopDetector: ToolLoopDetector
	/** The original user-provided AbortSignal (before wall-clock wrapping). */
	userSignal: AbortSignal | undefined
}
