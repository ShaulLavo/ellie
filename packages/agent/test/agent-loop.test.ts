import { describe, expect, test } from "bun:test";
import { agentLoop, agentLoopContinue } from "../src/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
	AssistantMessage,
} from "../src/types";
import type { StreamChunk, AnyTextAdapter } from "@tanstack/ai";
import * as v from "valibot";

// ============================================================================
// Test helpers
// ============================================================================

/** Create a mock StreamFn that yields predetermined AG-UI events */
function createMockStreamFn(events: StreamChunk[]): StreamFn {
	return async function* () {
		for (const event of events) {
			yield event;
		}
	};
}

/** Create a simple text response stream (no tool calls) */
function textResponseStream(text: string, runId = "run_1"): StreamChunk[] {
	return [
		{ type: "RUN_STARTED", runId, timestamp: Date.now() },
		{
			type: "TEXT_MESSAGE_START",
			messageId: "msg_1",
			role: "assistant" as const,
			timestamp: Date.now(),
		},
		{
			type: "TEXT_MESSAGE_CONTENT",
			messageId: "msg_1",
			delta: text,
			timestamp: Date.now(),
		},
		{
			type: "TEXT_MESSAGE_END",
			messageId: "msg_1",
			timestamp: Date.now(),
		},
		{
			type: "RUN_FINISHED",
			runId,
			finishReason: "stop" as const,
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			timestamp: Date.now(),
		},
	];
}

/** Create a tool call response stream */
function toolCallResponseStream(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	runId = "run_1",
): StreamChunk[] {
	return [
		{ type: "RUN_STARTED", runId, timestamp: Date.now() },
		{
			type: "TOOL_CALL_START",
			toolCallId,
			toolName,
			timestamp: Date.now(),
		},
		{
			type: "TOOL_CALL_ARGS",
			toolCallId,
			delta: JSON.stringify(args),
			timestamp: Date.now(),
		},
		{
			type: "TOOL_CALL_END",
			toolCallId,
			toolName,
			input: args,
			timestamp: Date.now(),
		},
		{
			type: "RUN_FINISHED",
			runId,
			finishReason: "tool_calls" as const,
			usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
			timestamp: Date.now(),
		},
	];
}

const mockAdapter = {} as AnyTextAdapter;

function createMockModel() {
	return {
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		provider: "anthropic" as const,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function defaultConvertToLlm(messages: AgentMessage[]) {
	// Simple filter — only pass through standard LLM messages
	return messages
		.filter(
			(m) =>
				m.role === "user" || m.role === "assistant" || m.role === "toolResult",
		)
		.map((m) => {
			if (m.role === "user") {
				return { role: "user" as const, content: "user msg" };
			}
			if (m.role === "assistant") {
				return { role: "assistant" as const, content: "assistant msg" };
			}
			return {
				role: "tool" as const,
				content: "tool result",
				toolCallId: (m as any).toolCallId,
			};
		});
}

async function collectEvents(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

// ============================================================================
// Tests
// ============================================================================

describe("agentLoop", () => {
	test("basic text response emits correct event sequence", async () => {
		const streamFn = createMockStreamFn(textResponseStream("Hello!"));

		const context: AgentContext = {
			systemPrompt: "Be helpful",
			messages: [],
		};

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hi" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(prompts, context, config, undefined, streamFn);
		const events = await collectEvents(stream);

		const types = events.map((e) => e.type);

		expect(types).toContain("agent_start");
		expect(types).toContain("turn_start");
		expect(types).toContain("message_start");
		expect(types).toContain("message_update");
		expect(types).toContain("message_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");

		// First message events should be for the user prompt
		const firstMsgStart = events.find((e) => e.type === "message_start");
		expect(firstMsgStart?.type === "message_start" && firstMsgStart.message.role).toBe("user");

		// Should have an assistant message
		const msgEnd = events.filter(
			(e) => e.type === "message_end" && e.message.role === "assistant",
		);
		expect(msgEnd.length).toBe(1);

		const assistantMsg = (msgEnd[0] as any).message as AssistantMessage;
		expect(assistantMsg.content[0]).toEqual({
			type: "text",
			text: "Hello!",
		});
		expect(assistantMsg.stopReason).toBe("stop");
		expect(assistantMsg.provider).toBe("anthropic");
		expect(assistantMsg.model).toBe("claude-sonnet-4-6");
	});

	test("tool call triggers execution and result events", async () => {
		const calculatorTool: AgentTool<any> = {
			name: "calculate",
			description: "Calculate a math expression",
			parameters: v.object({ expression: v.string() }),
			label: "Calculator",
			execute: async (_id, params) => ({
				content: [{ type: "text", text: "42" }],
				details: { expression: params.expression },
			}),
		};

		// First call returns tool call, second call returns text
		let callCount = 0;
		const streamFn: StreamFn = async function* (options) {
			callCount++;
			if (callCount === 1) {
				yield* toolCallResponseStream("tc_1", "calculate", {
					expression: "6*7",
				});
			} else {
				yield* textResponseStream("The answer is 42");
			}
		};

		const context: AgentContext = {
			systemPrompt: "You are a calculator",
			messages: [],
			tools: [calculatorTool],
		};

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "What is 6*7?" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(prompts, context, config, undefined, streamFn);
		const events = await collectEvents(stream);
		const types = events.map((e) => e.type);

		// Should have tool execution events
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");

		// Should have two turns
		const turnStarts = events.filter((e) => e.type === "turn_start");
		expect(turnStarts.length).toBe(2);

		// Tool result should be in events
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd?.type === "tool_execution_end" && toolEnd.isError).toBe(
			false,
		);
	});

	test("tool not found produces error result", async () => {
		const streamFn = createMockStreamFn(
			toolCallResponseStream("tc_1", "nonexistent", {}),
		);

		// Second call returns text (after tool result)
		let callCount = 0;
		const dynamicStreamFn: StreamFn = async function* () {
			callCount++;
			if (callCount === 1) {
				yield* toolCallResponseStream("tc_1", "nonexistent", {});
			} else {
				yield* textResponseStream("Sorry, tool not found");
			}
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Use a tool" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			dynamicStreamFn,
		);
		const events = await collectEvents(stream);

		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd?.type === "tool_execution_end" && toolEnd.isError).toBe(
			true,
		);
	});

	test("steering messages interrupt tool execution", async () => {
		let toolExecutionCount = 0;
		const slowTool: AgentTool<any> = {
			name: "slow_task",
			description: "A slow task",
			parameters: v.object({ id: v.number() }),
			label: "Slow",
			execute: async () => {
				toolExecutionCount++;
				return {
					content: [{ type: "text", text: `done ${toolExecutionCount}` }],
					details: {},
				};
			},
		};

		// Return two tool calls, then text
		let callCount = 0;
		const streamFn: StreamFn = async function* () {
			callCount++;
			if (callCount === 1) {
				// Two tool calls in one response
				yield {
					type: "RUN_STARTED",
					runId: "r1",
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_START",
					toolCallId: "tc_1",
					toolName: "slow_task",
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_ARGS",
					toolCallId: "tc_1",
					delta: '{"id":1}',
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_END",
					toolCallId: "tc_1",
					toolName: "slow_task",
					input: { id: 1 },
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_START",
					toolCallId: "tc_2",
					toolName: "slow_task",
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_ARGS",
					toolCallId: "tc_2",
					delta: '{"id":2}',
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "TOOL_CALL_END",
					toolCallId: "tc_2",
					toolName: "slow_task",
					input: { id: 2 },
					timestamp: Date.now(),
				} as StreamChunk;
				yield {
					type: "RUN_FINISHED",
					runId: "r1",
					finishReason: "tool_calls",
					usage: {
						promptTokens: 10,
						completionTokens: 10,
						totalTokens: 20,
					},
					timestamp: Date.now(),
				} as StreamChunk;
			} else {
				yield* textResponseStream("Acknowledged steering");
			}
		};

		let steeringReturned = false;
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
			getSteeringMessages: async () => {
				// Return steering after first tool execution
				if (!steeringReturned && toolExecutionCount >= 1) {
					steeringReturned = true;
					return [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "Stop!" }],
							timestamp: Date.now(),
						},
					];
				}
				return [];
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Do two tasks" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn,
		);
		const events = await collectEvents(stream);

		// Only one tool should have actually executed
		expect(toolExecutionCount).toBe(1);

		// Second tool should be skipped
		const toolEnds = events.filter((e) => e.type === "tool_execution_end");
		expect(toolEnds.length).toBe(2);
		const skipped = toolEnds[1];
		expect(skipped.type === "tool_execution_end" && skipped.isError).toBe(
			true,
		);
	});

	test("follow-up messages continue after agent would stop", async () => {
		let callCount = 0;
		const streamFn: StreamFn = async function* () {
			callCount++;
			yield* textResponseStream(`Response ${callCount}`);
		};

		let followUpReturned = false;
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
			getFollowUpMessages: async () => {
				if (!followUpReturned) {
					followUpReturned = true;
					return [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "Also do this" }],
							timestamp: Date.now(),
						},
					];
				}
				return [];
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "First task" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn,
		);
		const events = await collectEvents(stream);

		// Should have two assistant responses (original + follow-up)
		const assistantMsgEnds = events.filter(
			(e) => e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantMsgEnds.length).toBe(2);
		expect(callCount).toBe(2);
	});

	test("error in stream produces error assistant message", async () => {
		const streamFn: StreamFn = async function* () {
			yield {
				type: "RUN_STARTED",
				runId: "r1",
				timestamp: Date.now(),
			} as StreamChunk;
			yield {
				type: "RUN_ERROR",
				error: { message: "Rate limit exceeded" },
				timestamp: Date.now(),
			} as StreamChunk;
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
		};

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hi" }],
				timestamp: Date.now(),
			},
		];

		const stream = agentLoop(
			prompts,
			context,
			config,
			undefined,
			streamFn,
		);
		const events = await collectEvents(stream);

		const agentEnd = events.find((e) => e.type === "agent_end");
		expect(agentEnd).toBeDefined();

		const assistantMsgs = events.filter(
			(e) => e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantMsgs.length).toBe(1);
		const msg = (assistantMsgs[0] as any).message as AssistantMessage;
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe("Rate limit exceeded");
	});
});

describe("agentLoopContinue", () => {
	test("throws with empty messages", () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		expect(() => agentLoopContinue(context, config)).toThrow(
			"Cannot continue: no messages in context",
		);
	});

	test("throws when last message is assistant", () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
					provider: "anthropic",
					model: "test",
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
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
		};
		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		expect(() => agentLoopContinue(context, config)).toThrow(
			"Cannot continue from message role: assistant",
		);
	});

	test("continues from user message", async () => {
		const streamFn = createMockStreamFn(textResponseStream("Continued!"));

		const context: AgentContext = {
			systemPrompt: "",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Continue from here" }],
					timestamp: Date.now(),
				},
			],
		};

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: defaultConvertToLlm,
		};

		const stream = agentLoopContinue(
			context,
			config,
			undefined,
			streamFn,
		);
		const events = await collectEvents(stream);

		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("agent_end");

		const assistantMsgs = events.filter(
			(e) => e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantMsgs.length).toBe(1);
	});
});

describe("transformContext", () => {
	test("is called with messages and signal, and transformed output is used", async () => {
		let transformCalledWith: {
			messages: AgentMessage[];
			signal?: AbortSignal;
		} | null = null;
		let convertCalledWith: AgentMessage[] | null = null;

		const streamFn = createMockStreamFn(textResponseStream("Response"));

		const abortController = new AbortController();

		const config: AgentLoopConfig = {
			model: createMockModel(),
			adapter: mockAdapter,
			convertToLlm: (messages) => {
				// Capture a snapshot of what convertToLlm receives (should be the transformed output)
				convertCalledWith = [...messages];
				return defaultConvertToLlm(messages);
			},
			transformContext: async (messages, signal) => {
				// Capture a snapshot — the original array gets mutated later by runLoop
				transformCalledWith = { messages: [...messages], signal };
				// Simulate context trimming: only keep the last message
				return messages.slice(-1);
			},
		};

		const context: AgentContext = {
			systemPrompt: "Test",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Old message" }],
					timestamp: 1000,
				},
			],
		};

		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "New message" }],
				timestamp: 2000,
			},
		];

		const stream = agentLoop(
			prompts,
			context,
			config,
			abortController.signal,
			streamFn,
		);
		await collectEvents(stream);

		// transformContext should have been called
		expect(transformCalledWith).not.toBeNull();
		// It should receive the full context (old + new messages)
		expect(transformCalledWith!.messages.length).toBe(2);
		expect(transformCalledWith!.messages[0].role).toBe("user");
		expect(transformCalledWith!.messages[1].role).toBe("user");
		// It should receive the abort signal
		expect(transformCalledWith!.signal).toBe(abortController.signal);
		// convertToLlm should receive the trimmed output (only last message)
		expect(convertCalledWith).not.toBeNull();
		expect(convertCalledWith!.length).toBe(1);
		expect(convertCalledWith![0].role).toBe("user");
	});
});
