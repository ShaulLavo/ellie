/**
 * Server-side agent manager — manages Agent instances keyed by sessionId.
 *
 * Wires each agent's onEvent callback to persist events via the RealtimeStore,
 * and exposes control methods used by HTTP routes.
 */

import { Agent, type AgentOptions, type AgentEvent, type AgentMessage } from "@ellie/agent";
import type { AnyTextAdapter } from "@tanstack/ai";
import { ulid } from "@ellie/utils";
import type { RealtimeStore } from "../lib/realtime-store";

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
	private store: RealtimeStore;
	private options: AgentManagerOptions;

	constructor(store: RealtimeStore, options: AgentManagerOptions) {
		this.store = store;
		this.options = options;
	}

	/**
	 * Get or create an Agent for a session.
	 * Creates the session if it doesn't exist.
	 */
	getOrCreate(sessionId: string): Agent {
		let agent = this.agents.get(sessionId);
		if (agent) return agent;

		this.store.ensureSession(sessionId);

		agent = new Agent({
			...this.options.agentOptions,
			adapter: this.options.adapter,
			initialState: {
				...this.options.agentOptions?.initialState,
				systemPrompt: this.options.systemPrompt ?? "",
			},
			onEvent: (event) => this.handleEvent(sessionId, event),
		});

		this.agents.set(sessionId, agent);
		return agent;
	}

	/**
	 * Send a text prompt to an agent.
	 * Creates the agent if it doesn't exist. Loads history on first use.
	 * Returns the runId for event stream subscription.
	 */
	async prompt(sessionId: string, text: string): Promise<{ runId: string }> {
		const agent = this.getOrCreate(sessionId);

		// Load history if this is a fresh agent with no messages
		if (agent.state.messages.length === 0) {
			const history = this.loadHistory(sessionId);
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

		// Persist the user message as an event
		this.store.appendEvent(
			sessionId,
			"user_message",
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
			runId
		);

		// Store the runId so the event handler knows where to write
		agent.runId = runId;

		// Start the prompt (non-blocking — events flow via onEvent)
		agent.prompt(text).catch((err) => {
			console.error(`[agent-manager] prompt failed for ${sessionId}:`, err);
			// Write a terminal event so the client doesn't hang
			this.writeErrorEvent(sessionId, runId);
		});

		return { runId };
	}

	/**
	 * Queue a steering message for the running agent.
	 */
	steer(sessionId: string, text: string): void {
		const agent = this.agents.get(sessionId);
		if (!agent) throw new Error(`Agent not found for session ${sessionId}`);

		agent.steer({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
	}

	/**
	 * Abort the running agent prompt.
	 */
	abort(sessionId: string): void {
		const agent = this.agents.get(sessionId);
		if (!agent) throw new Error(`Agent not found for session ${sessionId}`);
		agent.abort();
	}

	/**
	 * Load conversation history from persisted events.
	 *
	 * The DB store returns `AgentMessage` from `@ellie/schemas` (where
	 * `provider` is `string`), but the Agent runtime expects `@ellie/agent`'s
	 * `AgentMessage` (where `provider` is `ProviderName`).  The data is
	 * structurally compatible — the DB just stores wider types — so a cast
	 * at this boundary is safe.
	 */
	loadHistory(sessionId: string): AgentMessage[] {
		return this.store.listAgentMessages(sessionId) as AgentMessage[];
	}

	/**
	 * Check if a session exists.
	 */
	hasSession(sessionId: string): boolean {
		return this.store.hasSession(sessionId);
	}

	/**
	 * Remove an agent from memory (does not delete the session).
	 * If the agent is actively streaming, eviction is deferred until the run completes.
	 */
	evict(sessionId: string): void {
		const agent = this.agents.get(sessionId);
		if (agent?.state.isStreaming) {
			const unsub = agent.subscribe((e) => {
				if (e.type === "agent_end") {
					unsub();
					this.agents.delete(sessionId);
				}
			});
			return;
		}
		this.agents.delete(sessionId);
	}

	// -- Internal ---

	private writeErrorEvent(sessionId: string, runId: string): void {
		try {
			this.store.appendEvent(
				sessionId,
				"error",
				{ message: "Agent prompt failed unexpectedly" },
				runId
			);
			this.store.closeAgentRun(sessionId, runId);
		} catch {
			// Stream may already be closed — nothing more to do
		}
	}

	private handleEvent(sessionId: string, event: AgentEvent): void {
		const agent = this.agents.get(sessionId);
		const runId = agent?.runId;

		if (runId) {
			try {
				this.store.appendAgentRunEvent(sessionId, runId, event);
			} catch {
				// Non-fatal
			}
		}

		// On agent_end, close the run
		if (event.type === "agent_end" && runId) {
			try {
				this.store.closeAgentRun(sessionId, runId);
			} catch {
				// Already closed — non-fatal
			}
			if (agent) {
				agent.runId = undefined;
			}
		}
	}
}
