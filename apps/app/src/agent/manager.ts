/**
 * Server-side agent manager — manages Agent instances keyed by chatId.
 *
 * Wires each agent's onEvent callback to persist events and messages,
 * and exposes control methods used by HTTP routes.
 */

import { Agent, type AgentOptions, type AgentEvent, type AgentMessage } from "@ellie/agent";
import type { AnyTextAdapter } from "@tanstack/ai";
import { ulid } from "@ellie/utils";

export interface AgentPersistenceStore {
	hasAgentMessages(chatId: string): boolean;
	ensureAgentMessages(chatId: string): void;
	listAgentMessages(chatId: string): AgentMessage[];
	appendAgentMessage(chatId: string, message: AgentMessage): void;
	createAgentRun(chatId: string, runId: string, ttlSeconds: number): void;
	appendAgentRunEvent(chatId: string, runId: string, event: AgentEvent): void;
	closeAgentRun(chatId: string, runId: string): void;
}

export interface AgentManagerOptions {
	/** TanStack AI adapter for LLM calls */
	adapter: AnyTextAdapter;
	/** Default system prompt for new agents */
	systemPrompt?: string;
	/** Additional AgentOptions passed to each new Agent */
	agentOptions?: Partial<AgentOptions>;
}

export class AgentManager {
	private agents = new Map<string, Agent>();
	private store: AgentPersistenceStore;
	private options: AgentManagerOptions;

	constructor(store: AgentPersistenceStore, options: AgentManagerOptions) {
		this.store = store;
		this.options = options;
	}

	/**
	 * Get or create an Agent for a chatId.
	 * Creates the durable message stream if it doesn't exist.
	 */
	getOrCreate(chatId: string): Agent {
		let agent = this.agents.get(chatId);
		if (agent) return agent;

		this.store.ensureAgentMessages(chatId);

		agent = new Agent({
			...this.options.agentOptions,
			adapter: this.options.adapter,
			initialState: {
				...this.options.agentOptions?.initialState,
				systemPrompt: this.options.systemPrompt ?? "",
			},
			onEvent: (event) => this.handleEvent(chatId, event),
		});

		this.agents.set(chatId, agent);
		return agent;
	}

	/**
	 * Send a text prompt to an agent.
	 * Creates the agent if it doesn't exist. Loads history on first use.
	 * Returns the runId for event stream subscription.
	 */
	async prompt(chatId: string, text: string): Promise<{ runId: string }> {
		const agent = this.getOrCreate(chatId);

		// Load history if this is a fresh agent with no messages
		if (agent.state.messages.length === 0) {
			const history = this.loadHistory(chatId);
			if (history.length > 0) {
				agent.replaceMessages(history);
			}
		}

		// Pre-flight checks — surface sync errors as HTTP errors to the caller
		if (agent.state.isStreaming) {
			throw new Error("Agent is already processing a prompt.");
		}
		if (!agent.adapter) {
			throw new Error("No adapter configured for agent.");
		}

		const runId = ulid();

		// Create the events stream for this run
		this.store.createAgentRun(chatId, runId, 3600);

		// Store the runId so the event handler knows where to write
		agent.runId = runId;

		// Start the prompt (non-blocking — events flow via onEvent)
		agent.prompt(text).catch((err) => {
			console.error(`[agent-manager] prompt failed for ${chatId}:`, err);
			// Write a terminal event so the client doesn't hang
			this.writeErrorEvent(chatId, runId);
		});

		return { runId };
	}

	/**
	 * Queue a steering message for the running agent.
	 */
	steer(chatId: string, text: string): void {
		const agent = this.agents.get(chatId);
		if (!agent) throw new Error(`No agent found for chat ${chatId}`);

		agent.steer({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
	}

	/**
	 * Abort the running agent prompt.
	 */
	abort(chatId: string): void {
		const agent = this.agents.get(chatId);
		if (!agent) throw new Error(`No agent found for chat ${chatId}`);
		agent.abort();
	}

	/**
	 * Load conversation history from the messages stream.
	 */
	loadHistory(chatId: string): AgentMessage[] {
		return this.store.listAgentMessages(chatId);
	}

	/**
	 * Check if a chat exists (has a messages stream).
	 */
	hasChat(chatId: string): boolean {
		return this.store.hasAgentMessages(chatId);
	}

	/**
	 * Remove an agent from memory (does not delete the stream).
	 * If the agent is actively streaming, eviction is deferred until the run completes.
	 */
	evict(chatId: string): void {
		const agent = this.agents.get(chatId);
		if (agent?.state.isStreaming) {
			// Defer eviction — subscribe to wait for completion
			const unsub = agent.subscribe((e) => {
				if (e.type === "agent_end") {
					unsub();
					this.agents.delete(chatId);
				}
			});
			return;
		}
		this.agents.delete(chatId);
	}

	// -- Internal ---

	/**
	 * Write a terminal agent_end event to the events stream.
	 * Used as a safety net when agent.prompt() rejects unexpectedly,
	 * so the client doesn't hang waiting for events that will never arrive.
	 */
	private writeErrorEvent(chatId: string, runId: string): void {
		try {
			const errorEvent: AgentEvent = { type: "agent_end", messages: [] };
			this.store.appendAgentRunEvent(chatId, runId, errorEvent);
			this.store.closeAgentRun(chatId, runId);
		} catch {
			// Stream may already be closed — nothing more to do
		}
	}

	/**
	 * Handle an AgentEvent — persist to storage.
	 */
	private handleEvent(chatId: string, event: AgentEvent): void {
		const agent = this.agents.get(chatId);
		const runId = agent?.runId;

		// Write event to the run event stream (if we have a runId)
		if (runId) {
			try {
				this.store.appendAgentRunEvent(chatId, runId, event);
			} catch {
				// Events stream may not exist or be closed — non-fatal
			}
		}

		// On message_end, persist the finalized message to the messages stream
		if (event.type === "message_end") {
			try {
				this.store.appendAgentMessage(chatId, event.message);
			} catch (err) {
				console.error(`[agent-manager] failed to persist message for ${chatId}:`, err);
			}
		}

		// On agent_end, close the events stream
		if (event.type === "agent_end" && runId) {
			try {
				this.store.closeAgentRun(chatId, runId);
			} catch {
				// Already closed or doesn't exist — non-fatal
			}
			// Clear the runId
			if (agent) {
				agent.runId = undefined;
			}
		}
	}
}
