/**
 * Agent class — stateful wrapper around the agent loop.
 *
 * Manages conversation state, event subscriptions, steering/follow-up queues,
 * and delegates to agentLoop/agentLoopContinue for actual execution.
 */

import {
	getModel,
	type Model,
	type ThinkingLevel,
} from "@ellie/ai";
import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { agentLoop, agentLoopContinue } from "./agent-loop";
import { toModelMessages } from "./messages";
import { isAssistantMessage, isMessage } from "./types";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	ImageContent,
	StreamFn,
	TextContent,
} from "./types";

/**
 * Default convertToLlm: Keep only LLM-compatible messages.
 */
function defaultConvertToLlm(messages: AgentMessage[]): ModelMessage[] {
	return toModelMessages(messages.filter(isMessage));
}

export interface AgentOptions {
	initialState?: Partial<AgentState>;

	/** TanStack AI adapter (e.g., anthropicText("claude-sonnet-4-6")) */
	adapter?: AnyTextAdapter;

	/** Converts AgentMessage[] to LLM-compatible ModelMessage[] before each LLM call. */
	convertToLlm?: (
		messages: AgentMessage[],
	) => ModelMessage[] | Promise<ModelMessage[]>;

	/** Optional transform applied to context before convertToLlm. */
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;

	/** Steering mode: "all" = send all at once, "one-at-a-time" = one per turn */
	steeringMode?: "all" | "one-at-a-time";

	/** Follow-up mode: "all" = send all at once, "one-at-a-time" = one per turn */
	followUpMode?: "all" | "one-at-a-time";

	/** Custom stream function (for alternative backends). Default uses TanStack AI chat(). */
	streamFn?: StreamFn;

	/** Called for each AgentEvent alongside EventStream.push(). Use for durable persistence. */
	onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export class Agent {
	private _state: AgentState;
	private listeners = new Set<(e: AgentEvent) => void>();
	private abortController?: AbortController;
	private convertToLlm: (
		messages: AgentMessage[],
	) => ModelMessage[] | Promise<ModelMessage[]>;
	private transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;
	private steeringQueue: AgentMessage[] = [];
	private followUpQueue: AgentMessage[] = [];
	private steeringMode: "all" | "one-at-a-time";
	private followUpMode: "all" | "one-at-a-time";
	public streamFn?: StreamFn;
	public adapter?: AnyTextAdapter;
	public onEvent?: (event: AgentEvent) => void | Promise<void>;
	/** Current run ID. Set by external managers before prompt() and cleared automatically. */
	public runId?: string;
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;

	constructor(opts: AgentOptions = {}) {
		this._state = {
			systemPrompt: "",
			model: getModel("anthropic", "claude-sonnet-4-6")!,
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set<string>(),
			error: undefined,
			...opts.initialState,
		};
		this.convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.transformContext = opts.transformContext;
		this.steeringMode = opts.steeringMode || "one-at-a-time";
		this.followUpMode = opts.followUpMode || "one-at-a-time";
		this.streamFn = opts.streamFn;
		this.adapter = opts.adapter;
		this.onEvent = opts.onEvent;
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// --- State mutators ---

	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	setModel(m: Model) {
		this._state.model = m;
	}

	setThinkingLevel(l: ThinkingLevel | "off") {
		this._state.thinkingLevel = l;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.followUpMode;
	}

	setTools(t: AgentTool<any>[]) {
		this._state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	clearMessages() {
		this._state.messages = [];
	}

	// --- Steering & follow-up queues ---

	steer(m: AgentMessage) {
		this.steeringQueue.push(m);
	}

	followUp(m: AgentMessage) {
		this.followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.followUpQueue = [];
	}

	clearAllQueues() {
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}

	private dequeueSteeringMessages(): AgentMessage[] {
		if (this.steeringMode === "one-at-a-time") {
			if (this.steeringQueue.length > 0) {
				const first = this.steeringQueue[0];
				this.steeringQueue = this.steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.steeringQueue.slice();
		this.steeringQueue = [];
		return steering;
	}

	private dequeueFollowUpMessages(): AgentMessage[] {
		if (this.followUpMode === "one-at-a-time") {
			if (this.followUpQueue.length > 0) {
				const first = this.followUpQueue[0];
				this.followUpQueue = this.followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.followUpQueue.slice();
		this.followUpQueue = [];
		return followUp;
	}

	// --- Lifecycle ---

	abort() {
		this.abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve();
	}

	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set<string>();
		this._state.error = undefined;
		this.steeringQueue = [];
		this.followUpQueue = [];
		this.runId = undefined;
	}

	// --- Prompting ---

	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	) {
		if (this._state.isStreaming) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		if (!this.adapter) {
			throw new Error(
				"No adapter configured. Pass an adapter via AgentOptions.",
			);
		}

		let msgs: AgentMessage[];

		if (Array.isArray(input)) {
			msgs = input;
		} else if (typeof input === "string") {
			const content: Array<TextContent | ImageContent> = [
				{ type: "text", text: input },
			];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
		}

		await this._runLoop(msgs);
	}

	async continue() {
		if (this._state.isStreaming) {
			throw new Error(
				"Agent is already processing. Wait for completion before continuing.",
			);
		}

		const messages = this._state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}

		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, {
					skipInitialSteeringPoll: true,
				});
				return;
			}

			const queuedFollowUp = this.dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this._runLoop(undefined);
	}

	// --- Internal ---

	private async _runLoop(
		messages?: AgentMessage[],
		options?: { skipInitialSteeringPoll?: boolean },
	) {
		if (!this.adapter) {
			throw new Error("No adapter configured.");
		}

		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = undefined;

		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools,
		};

		let skipInitialSteeringPoll =
			options?.skipInitialSteeringPoll === true;

		const config: AgentLoopConfig = {
			model: this._state.model,
			adapter: this.adapter,
			thinkingLevel: this._state.thinkingLevel,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
			onEvent: this.onEvent,
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(
						messages,
						context,
						config,
						this.abortController.signal,
						this.streamFn,
					)
				: agentLoopContinue(
						context,
						config,
						this.abortController.signal,
						this.streamFn,
					);

			for await (const event of stream) {
				// Update internal state based on events
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_end":
						partial = null;
						this._state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start": {
						const s = new Set(this._state.pendingToolCalls);
						s.add(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "tool_execution_end": {
						const s = new Set(this._state.pendingToolCalls);
						s.delete(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "turn_end":
						if (
							isAssistantMessage(event.message) &&
							event.message.errorMessage
						) {
							this._state.error = event.message.errorMessage;
						}
						break;

					case "agent_end":
						this._state.isStreaming = false;
						this._state.streamMessage = null;
						break;
				}

				this.emit(event);
			}

			// Handle any remaining partial message
			if (
				partial &&
				isAssistantMessage(partial) &&
				partial.content.length > 0
			) {
				const onlyEmpty = !partial.content.some(
					(c) =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				}
			}
		} catch (err: any) {
			const errorMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				provider: this._state.model.provider,
				model: this._state.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: this.abortController?.signal.aborted
					? "aborted"
					: "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			};

			this.appendMessage(errorMsg);
			this._state.error = err?.message || String(err);
			this.emit({ type: "agent_end", messages: [errorMsg] });
		} finally {
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this.abortController = undefined;
			this.runId = undefined;
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
		}
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}
}
