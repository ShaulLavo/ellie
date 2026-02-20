import { describe, expect, test } from "bun:test";
import { isMessage, isAssistantMessage } from "../src/types";
import type {
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	AgentMessage,
} from "../src/types";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("isMessage", () => {
	test("returns true for UserMessage", () => {
		const msg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: 1000,
		};
		expect(isMessage(msg)).toBe(true);
	});

	test("returns true for AssistantMessage", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hi" }],
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage,
			stopReason: "stop",
			timestamp: 1000,
		};
		expect(isMessage(msg)).toBe(true);
	});

	test("returns true for ToolResultMessage", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "test",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 1000,
		};
		expect(isMessage(msg)).toBe(true);
	});

	test("returns false for object with assistant role but no provider", () => {
		// Simulates a custom message that happens to use role "assistant"
		const custom = { role: "assistant" as const, data: "custom" } as AgentMessage;
		expect(isMessage(custom)).toBe(false);
	});

	test("narrows type so toModelMessages compiles", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello" }],
				timestamp: 1000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				usage,
				stopReason: "stop",
				timestamp: 1000,
			},
		];

		const filtered = messages.filter(isMessage);
		// TypeScript now knows this is Message[]
		expect(filtered.length).toBe(2);
		expect(filtered[0].role).toBe("user");
		expect(filtered[1].role).toBe("assistant");
	});
});

describe("isAssistantMessage", () => {
	test("returns true for AssistantMessage", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hi" }],
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage,
			stopReason: "stop",
			timestamp: 1000,
		};
		expect(isAssistantMessage(msg)).toBe(true);
	});

	test("returns true for AssistantMessage with errorMessage", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage,
			stopReason: "error",
			errorMessage: "Something went wrong",
			timestamp: 1000,
		};
		expect(isAssistantMessage(msg)).toBe(true);
		// After narrowing, errorMessage is accessible
		if (isAssistantMessage(msg)) {
			expect(msg.errorMessage).toBe("Something went wrong");
		}
	});

	test("returns false for UserMessage", () => {
		const msg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: 1000,
		};
		expect(isAssistantMessage(msg)).toBe(false);
	});

	test("returns false for ToolResultMessage", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "test",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 1000,
		};
		expect(isAssistantMessage(msg)).toBe(false);
	});

	test("returns false for custom message with assistant role but no provider", () => {
		const custom = { role: "assistant" as const, data: "custom" } as AgentMessage;
		expect(isAssistantMessage(custom)).toBe(false);
	});
});
