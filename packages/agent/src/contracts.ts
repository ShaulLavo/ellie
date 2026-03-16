/**
 * Shared definition contracts for agent packages.
 *
 * Both @ellie/assistant-agent and @ellie/coding-agent implement
 * AgentDefinition to compose the core Agent — no subclassing.
 */

import type { Model, ThinkingLevel } from '@ellie/ai'
import type {
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import type { AgentMessage, AgentTool } from './types'
import type { Skill } from './skills/types'

// ---------------------------------------------------------------------------
// NormalizedUserInput
// ---------------------------------------------------------------------------

export interface NormalizedUserInput {
	/** The (possibly expanded) user text. */
	text: string
	/** Original raw text before any transformation. */
	rawText: string
	/** Row ID of the persisted user_message event, if available. */
	userMessageRowId?: number
}

// ---------------------------------------------------------------------------
// AgentHostServices — host-safe dependencies exposed to definitions
// ---------------------------------------------------------------------------

export interface AgentHostServices {
	/** Absolute path to the workspace directory. */
	workspaceDir: string
	/** Absolute path to the data directory. */
	dataDir: string
	/** Absolute path to the credentials file. */
	credentialsPath?: string

	/** Load conversation history for a branch. */
	loadHistory: (branchId: string) => AgentMessage[]
	/** Resolve the threadId for a branch. */
	getThreadId: (branchId: string) => string | undefined

	/** Trace recorder for structured trace events. */
	traceRecorder?: TraceRecorder
	/** Blob sink for overflow storage. */
	blobSink?: BlobSink
	/** Get the active trace scope for the current run. */
	getTraceScope: () => TraceScope | undefined
	/** Append an event to the event store. */
	appendEvent: (
		branchId: string,
		type: string,
		payload: unknown,
		runId?: string
	) => void

	/** Event store for querying/persisting events. */
	eventStore?: unknown
}

// ---------------------------------------------------------------------------
// AgentContextSnapshot — what the host feeds to the Agent
// ---------------------------------------------------------------------------

export interface AgentContextSnapshot {
	systemPrompt: string
	messages: AgentMessage[]
	tools: AgentTool[]
	model?: Model
	thinkingLevel?: ThinkingLevel | 'off'
}

// ---------------------------------------------------------------------------
// AgentRunHooks — lifecycle hooks around a run
// ---------------------------------------------------------------------------

export interface AgentRunHooks {
	beforeRun?: (
		branchId: string,
		runId: string,
		context: AgentContextSnapshot,
		services: AgentHostServices
	) => Promise<AgentContextSnapshot>

	afterRun?: (
		branchId: string,
		runId: string,
		services: AgentHostServices
	) => Promise<void>
}

// ---------------------------------------------------------------------------
// AgentDefinition — the shared contract both agent packages implement
// ---------------------------------------------------------------------------

export interface AgentDefinition {
	/** The agent type identifier (e.g. 'assistant', 'coding'). */
	agentType: string

	/** Normalize raw user input (e.g. skill expansion). */
	normalizeUserInput(
		input: NormalizedUserInput,
		services: AgentHostServices
	): NormalizedUserInput

	/** Filter discovered skills for this agent. */
	selectSkills?(
		allSkills: Skill[],
		services: AgentHostServices
	): Skill[]

	/** Build prompt sections for the system prompt. */
	buildPromptSections?(
		services: AgentHostServices
	): string[]

	/** Build the full context snapshot for a run. */
	buildContext(
		branchId: string,
		normalizedInput: NormalizedUserInput,
		services: AgentHostServices
	): Promise<AgentContextSnapshot>

	/** Select the tool set for this agent. */
	selectTools?(services: AgentHostServices): AgentTool[]

	/** Lifecycle hooks for before/after a run. */
	hooks?: AgentRunHooks

	/** Called when a branch is bound to this definition. */
	onBind?(
		branchId: string,
		services: AgentHostServices
	): void

	/** Called when a branch is unbound from this definition. */
	onUnbind?(
		branchId: string,
		services: AgentHostServices
	): void
}
