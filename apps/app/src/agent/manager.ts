/**
 * Server-side agent manager — manages Agent instances keyed by chatId.
 *
 * Wires each agent's onEvent callback to persist events to durable streams,
 * and writes finalized messages to the chat's message stream.
 */

import { Agent, type AgentOptions, type AgentEvent, type AgentMessage } from "@ellie/agent";
import { agentMessageSchema } from "@ellie/agent";
import type { IStreamStore } from "@ellie/durable-streams";
import type { AnyTextAdapter } from "@tanstack/ai";
import { ulid } from "@ellie/utils";
import * as v from "valibot";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
	private store: IStreamStore;
	private options: AgentManagerOptions;

	constructor(store: IStreamStore, options: AgentManagerOptions) {
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

		// Ensure the messages stream exists
		const messagesPath = this.messagesPath(chatId);
		if (!this.store.has(messagesPath)) {
			this.store.create(messagesPath, {
				contentType: "application/json",
			});
		}

		agent = new Agent({
			adapter: this.options.adapter,
			...this.options.agentOptions,
			initialState: {
				systemPrompt: this.options.systemPrompt ?? "",
				...this.options.agentOptions?.initialState,
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

		const runId = ulid();

		// Create the events stream for this run
		const eventsPath = this.eventsPath(chatId, runId);
		this.store.create(eventsPath, {
			contentType: "application/json",
			ttlSeconds: 3600, // 1 hour TTL for event streams
		});

		// Store the runId so the event handler knows where to write
		agent.runId = runId;

		// Start the prompt (non-blocking — events flow via onEvent)
		agent.prompt(text).catch((err) => {
			console.error(`[agent-manager] prompt failed for ${chatId}:`, err);
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
		const messagesPath = this.messagesPath(chatId);
		if (!this.store.has(messagesPath)) return [];

		const { messages } = this.store.read(messagesPath);
		const result: AgentMessage[] = [];

		for (const msg of messages) {
			try {
				const json = JSON.parse(decoder.decode(stripTrailingComma(msg.data)));
				const parsed = v.parse(agentMessageSchema, json);
				result.push(parsed as AgentMessage);
			} catch {
				// Skip corrupted entries
				continue;
			}
		}

		return result;
	}

	/**
	 * Check if a chat exists (has a messages stream).
	 */
	hasChat(chatId: string): boolean {
		return this.store.has(this.messagesPath(chatId));
	}

	/**
	 * Remove an agent from memory (does not delete the stream).
	 */
	evict(chatId: string): void {
		this.agents.delete(chatId);
	}

	// -- Internal ---

	private messagesPath(chatId: string): string {
		return `/agent/${chatId}`;
	}

	private eventsPath(chatId: string, runId: string): string {
		return `/agent/${chatId}/events/${runId}`;
	}

	/**
	 * Handle an AgentEvent — persist to durable streams.
	 */
	private handleEvent(chatId: string, event: AgentEvent): void {
		const agent = this.agents.get(chatId);
		const runId = agent?.runId;

		// Write event to the events stream (if we have a runId)
		if (runId) {
			const eventsPath = this.eventsPath(chatId, runId);
			try {
				const data = encoder.encode(JSON.stringify(event));
				this.store.append(eventsPath, data);
			} catch {
				// Events stream may not exist or be closed — non-fatal
			}
		}

		// On message_end, persist the finalized message to the messages stream
		if (event.type === "message_end") {
			const messagesPath = this.messagesPath(chatId);
			try {
				const data = encoder.encode(JSON.stringify(event.message));
				this.store.append(messagesPath, data);
			} catch (err) {
				console.error(`[agent-manager] failed to persist message for ${chatId}:`, err);
			}
		}

		// On agent_end, close the events stream
		if (event.type === "agent_end" && runId) {
			const eventsPath = this.eventsPath(chatId, runId);
			try {
				this.store.closeStream(eventsPath);
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

// -- Helpers --

/**
 * Strip trailing comma from JSON store format.
 * Messages are stored comma-terminated by processJsonAppend.
 */
function stripTrailingComma(data: Uint8Array): Uint8Array {
	let end = data.length;
	while (end > 0 && (data[end - 1] === 0x20 || data[end - 1] === 0x0a || data[end - 1] === 0x0d || data[end - 1] === 0x09)) {
		end--;
	}
	if (end > 0 && data[end - 1] === 0x2c) {
		return data.subarray(0, end - 1);
	}
	return data;
}
