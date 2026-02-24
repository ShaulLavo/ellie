import { describe, expect, test, beforeEach } from "bun:test";
import { AgentManager, type AgentPersistenceStore } from "./manager";
import type { AgentEvent, AgentMessage } from "@ellie/agent";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";

class InMemoryAgentStore implements AgentPersistenceStore {
	private messagesByChat = new Map<string, AgentMessage[]>();
	private runs = new Set<string>();

	hasAgentMessages(chatId: string): boolean {
		return this.messagesByChat.has(chatId);
	}

	ensureAgentMessages(chatId: string): void {
		if (this.messagesByChat.has(chatId)) return;
		this.messagesByChat.set(chatId, []);
	}

	listAgentMessages(chatId: string): AgentMessage[] {
		return [...(this.messagesByChat.get(chatId) ?? [])];
	}

	appendAgentMessage(chatId: string, message: AgentMessage): void {
		this.ensureAgentMessages(chatId);
		const messages = this.messagesByChat.get(chatId)!;
		messages.push(message);
	}

	createAgentRun(chatId: string, runId: string, _ttlSeconds: number): void {
		this.runs.add(`${chatId}:${runId}`);
	}

	appendAgentRunEvent(_chatId: string, _runId: string, _event: AgentEvent): void {
		// No-op for these tests.
	}

	closeAgentRun(_chatId: string, _runId: string): void {
		// No-op for these tests.
	}

	hasRun(chatId: string, runId: string): boolean {
		return this.runs.has(`${chatId}:${runId}`);
	}
}

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Create a mock adapter that yields a simple text response.
 */
function createMockAdapter(): AnyTextAdapter {
	return {
		name: "mock",
		chat: async function* (): AsyncIterable<StreamChunk> {
			yield { type: "RUN_STARTED", threadId: "t1", runId: "r1" } as unknown as StreamChunk;
			yield { type: "TEXT_MESSAGE_START", messageId: "m1" } as unknown as StreamChunk;
			yield { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello from mock!" } as unknown as StreamChunk;
			yield { type: "TEXT_MESSAGE_END", messageId: "m1" } as unknown as StreamChunk;
			yield {
				type: "RUN_FINISHED",
				threadId: "t1",
				runId: "r1",
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			} as unknown as StreamChunk;
		},
	} as unknown as AnyTextAdapter;
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentManager", () => {
	let store: InMemoryAgentStore;
	let manager: AgentManager;

	beforeEach(() => {
		store = new InMemoryAgentStore();
		manager = new AgentManager(store, {
			adapter: createMockAdapter(),
			systemPrompt: "You are a test assistant.",
		});
	});

	test("getOrCreate creates agent and message stream", () => {
		const agent = manager.getOrCreate("chat-1");

		expect(agent).toBeDefined();
		expect(agent.state.systemPrompt).toBe("You are a test assistant.");
		expect(store.hasAgentMessages("chat-1")).toBe(true);
	});

	test("getOrCreate returns same agent for same chatId", () => {
		const agent1 = manager.getOrCreate("chat-1");
		const agent2 = manager.getOrCreate("chat-1");

		expect(agent1).toBe(agent2);
	});

	test("getOrCreate returns different agents for different chatIds", () => {
		const agent1 = manager.getOrCreate("chat-1");
		const agent2 = manager.getOrCreate("chat-2");

		expect(agent1).not.toBe(agent2);
	});

	test("hasChat returns false for non-existent chat", () => {
		expect(manager.hasChat("nonexistent")).toBe(false);
	});

	test("hasChat returns true after getOrCreate", () => {
		manager.getOrCreate("chat-1");
		expect(manager.hasChat("chat-1")).toBe(true);
	});

	test("loadHistory returns empty for new chat", () => {
		manager.getOrCreate("chat-1");
		const history = manager.loadHistory("chat-1");
		expect(history).toEqual([]);
	});

	test("prompt creates events stream and persists messages", async () => {
		const { runId } = await manager.prompt("chat-1", "Hello");

		expect(runId).toBeDefined();
		expect(typeof runId).toBe("string");
		expect(runId.length).toBeGreaterThan(0);

		// Wait for agent to finish
		const agent = manager.getOrCreate("chat-1");
		await agent.waitForIdle();

		// Check messages were persisted
		const history = manager.loadHistory("chat-1");
		expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant

		// First message should be the user message
		const userMsg = history.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
		expect(((userMsg as unknown as { content: { text: string }[] })?.content[0]?.text)).toBe("Hello");

		// Should have an assistant response
		const assistantMsg = history.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
	});

	test("prompt creates events stream with TTL", async () => {
		const { runId } = await manager.prompt("chat-1", "Test");

		// Events stream should exist
		expect(store.hasRun("chat-1", runId)).toBe(true);

		// Wait for agent to finish
		const agent = manager.getOrCreate("chat-1");
		await agent.waitForIdle();
	});

	test("steer throws for non-existent agent", () => {
		expect(() => manager.steer("nonexistent", "Hey")).toThrow(
			"No agent found for chat nonexistent",
		);
	});

	test("abort throws for non-existent agent", () => {
		expect(() => manager.abort("nonexistent")).toThrow(
			"No agent found for chat nonexistent",
		);
	});

	test("evict removes agent from memory", () => {
		manager.getOrCreate("chat-1");
		manager.evict("chat-1");

		// Should create a new agent
		const newAgent = manager.getOrCreate("chat-1");
		expect(newAgent.state.messages.length).toBe(0);
	});

	test("multiple prompts accumulate history", async () => {
		await manager.prompt("chat-1", "First message");
		const agent = manager.getOrCreate("chat-1");
		await agent.waitForIdle();

		await manager.prompt("chat-1", "Second message");
		await agent.waitForIdle();

		const history = manager.loadHistory("chat-1");

		// Should have at least 4 messages: user1, assistant1, user2, assistant2
		const userMsgs = history.filter((m) => m.role === "user");
		const assistantMsgs = history.filter((m) => m.role === "assistant");

		expect(userMsgs.length).toBe(2);
		expect(assistantMsgs.length).toBe(2);
	});
});
