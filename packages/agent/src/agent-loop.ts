/**
 * Agent loop — orchestrates multi-turn LLM conversations with tool execution.
 *
 * Delegates the tool-call/re-call loop to TanStack AI's chat() with
 * agentLoopStrategy: maxIterations(). Handles steering (mid-execution
 * interrupts) and follow-up messages as an outer loop.
 */

import { chat, maxIterations, type StreamChunk } from "@tanstack/ai";
import { mapTanStackUsage, toThinkingModelOptions } from "@ellie/ai";
import type { Model, Usage } from "@ellie/ai";
import * as v from "valibot";
import { EventStream } from "./event-stream";
import { toModelMessages } from "./messages";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AssistantMessage,
	AssistantStreamEvent,
	ToolCall,
	ToolResultMessage,
	StreamFn,
} from "./types";

/**
 * Start an agent loop with new prompt messages.
 * Prompts are added to context and events are emitted for them.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	const emit = createEmitter(stream, config);

	(async () => {
		try {
			const newMessages: AgentMessage[] = [...prompts];
			const currentContext: AgentContext = {
				...context,
				messages: [...context.messages, ...prompts],
			};

			emit({ type: "agent_start" });
			emit({ type: "turn_start" });

			for (const prompt of prompts) {
				emit({ type: "message_start", message: prompt });
				emit({ type: "message_end", message: prompt });
			}

			await runLoop(currentContext, newMessages, config, signal, stream, emit, streamFn);
		} catch (err) {
			emit({ type: "agent_end", messages: [] });
			stream.end([]);
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding new messages.
 * Used for retries — context already has user message or tool results.
 *
 * The last message must be a user or toolResult.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();
	const emit = createEmitter(stream, config);

	(async () => {
		try {
			const newMessages: AgentMessage[] = [];
			const currentContext: AgentContext = { ...context };

			emit({ type: "agent_start" });
			emit({ type: "turn_start" });

			await runLoop(currentContext, newMessages, config, signal, stream, emit, streamFn);
		} catch (err) {
			emit({ type: "agent_end", messages: [] });
			stream.end([]);
		}
	})();

	return stream;
}

// ============================================================================
// Internal
// ============================================================================

type EmitFn = (event: AgentEvent) => void;

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event) => event.type === "agent_end",
		(event) => (event.type === "agent_end" ? event.messages : []),
	);
}

function createEmitter(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): EmitFn {
	return (event: AgentEvent) => {
		stream.push(event);
		try {
			const result = config.onEvent?.(event);
			if (result && typeof (result as any).catch === "function") {
				(result as any).catch((err: unknown) => {
					console.error("[agent-loop] async onEvent error:", err);
				});
			}
		} catch (err) {
			console.error("[agent-loop] onEvent error:", err);
		}
	};
}

function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ============================================================================
// Tool bridge — wraps AgentTool[] into TanStack Tool[] with execute
// ============================================================================

/**
 * Tracks TOOL_CALL_START events so wrapped execute functions can
 * correlate which toolCallId they're executing for.
 * Safe because TanStack emits all TOOL_CALL_START events for an
 * iteration before calling any execute functions.
 */
interface ToolCallTracker {
	register(toolCallId: string, toolName: string): void;
	dequeue(toolName: string): string;
}

function createToolCallTracker(): ToolCallTracker {
	const pending = new Map<string, string[]>();
	return {
		register(toolCallId: string, toolName: string) {
			let ids = pending.get(toolName);
			if (!ids) {
				ids = [];
				pending.set(toolName, ids);
			}
			ids.push(toolCallId);
		},
		dequeue(toolName: string): string {
			const ids = pending.get(toolName);
			if (ids && ids.length > 0) {
				return ids.shift()!;
			}
			return `unknown_${Date.now()}`;
		},
	};
}

/**
 * Wrap AgentTool[] into TanStack AI tools with execute functions.
 * Each wrapper:
 * - Dequeues the toolCallId from the tracker
 * - Emits tool_execution_start/update/end events
 * - Validates args with Valibot
 * - Passes signal and onUpdate to the real tool
 * - Creates and emits ToolResultMessage
 * - Returns text content for TanStack's conversation history
 */
function wrapToolsForTanStack(
	tools: AgentTool<any>[],
	tracker: ToolCallTracker,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	toolResultCollector: ToolResultMessage[],
) {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		execute: async (args: unknown) => {
			const toolCallId = tracker.dequeue(tool.name);

			emit({
				type: "tool_execution_start",
				toolCallId,
				toolName: tool.name,
				args,
			});

			let result: AgentToolResult;
			let isError = false;

			try {
				const validatedArgs = v.parse(tool.parameters, args);
				result = await tool.execute(
					toolCallId,
					validatedArgs,
					signal,
					(partialResult) => {
						emit({
							type: "tool_execution_update",
							toolCallId,
							toolName: tool.name,
							args,
							partialResult,
						});
					},
				);
			} catch (e) {
				result = {
					content: [
						{
							type: "text",
							text: e instanceof Error ? e.message : String(e),
						},
					],
					details: {},
				};
				isError = true;
			}

			emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: tool.name,
				result,
				isError,
			});

			// Create and emit ToolResultMessage for persistence
			const toolResultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: tool.name,
				content: result.content,
				details: result.details,
				isError,
				timestamp: Date.now(),
			};
			toolResultCollector.push(toolResultMessage);
			emit({ type: "message_start", message: toolResultMessage });
			emit({ type: "message_end", message: toolResultMessage });

			// Return text for TanStack's conversation history
			return result.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.join("");
		},
	}));
}

// ============================================================================
// Main loop
// ============================================================================

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 *
 * TanStack AI handles the tool-call loop internally via maxIterations().
 * This outer loop handles steering and follow-up messages.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	emit: EmitFn,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages: AgentMessage[] =
		(await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when steering or follow-up messages arrive
	while (true) {
		if (!firstTurn) {
			emit({ type: "turn_start" });
		} else {
			firstTurn = false;
		}

		// Inject pending messages before next assistant response
		if (pendingMessages.length > 0) {
			for (const message of pendingMessages) {
				emit({ type: "message_start", message });
				emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];
		}

		// Process assistant response
		// With chat(): TanStack handles tool loop internally via maxIterations.
		// With streamFn: we must handle tool execution + re-call manually.
		let result = await processAgentStream(
			currentContext,
			config,
			signal,
			emit,
			streamFn,
		);

		// Collect messages from this iteration
		for (const msg of result.messages) {
			newMessages.push(msg);
		}

		// When using streamFn, handle tool execution loop manually
		if (streamFn) {
			let iterations = 0;
			const maxTurns = config.maxTurns ?? 10;
			while (
				!result.abortedOrError &&
				result.lastAssistant.stopReason === "toolUse" &&
				iterations < maxTurns
			) {
				iterations++;

				// Execute tool calls from the assistant message
				const toolCalls = result.lastAssistant.content.filter(
					(c): c is ToolCall => c.type === "toolCall",
				);
				let steered = false;
				for (let i = 0; i < toolCalls.length; i++) {
					if (signal?.aborted) break;

					// Check for steering between tool executions
					const midSteering = (await config.getSteeringMessages?.()) || [];
					if (midSteering.length > 0) {
						pendingMessages = midSteering;
						steered = true;
						// Emit skipped tool results for remaining calls (including current)
						for (let j = i; j < toolCalls.length; j++) {
							const remaining = toolCalls[j];
							const skipResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: remaining.id,
								toolName: remaining.name,
								content: [{ type: "text", text: "Tool execution skipped due to steering" }],
								isError: true,
								timestamp: Date.now(),
							};
							emit({ type: "tool_execution_start", toolCallId: remaining.id, toolName: remaining.name, args: remaining.arguments });
							emit({ type: "tool_execution_end", toolCallId: remaining.id, toolName: remaining.name, result: { content: skipResult.content, details: {} }, isError: true });
							emit({ type: "message_start", message: skipResult });
							emit({ type: "message_end", message: skipResult });
							currentContext.messages.push(skipResult);
							newMessages.push(skipResult);
						}
						break;
					}

					const toolResults = await executeToolCall(
						toolCalls[i], currentContext.tools ?? [], signal, emit,
					);
					for (const tr of toolResults) {
						currentContext.messages.push(tr);
						newMessages.push(tr);
					}
				}
				if (steered) break;

				if (signal?.aborted) break;

				// Re-call the LLM with tool results
				result = await processAgentStream(
					currentContext, config, signal, emit, streamFn,
				);
				for (const msg of result.messages) {
					newMessages.push(msg);
				}
			}
		}

		if (result.abortedOrError) {
			emit({ type: "turn_end", message: result.lastAssistant, toolResults: result.toolResults });
			emit({ type: "agent_end", messages: newMessages });
			stream.end(newMessages);
			return;
		}

		emit({ type: "turn_end", message: result.lastAssistant, toolResults: result.toolResults });

		// Check for steering messages after turn
		pendingMessages = (await config.getSteeringMessages?.()) || [];
		if (pendingMessages.length > 0) continue;

		// Check for follow-up messages
		const followUps = (await config.getFollowUpMessages?.()) || [];
		if (followUps.length > 0) {
			pendingMessages = followUps;
			continue;
		}

		break;
	}

	emit({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

// ============================================================================
// Manual tool execution (used when streamFn bypasses TanStack's agent loop)
// ============================================================================

/**
 * Execute a single tool call manually. Used for the streamFn path
 * where TanStack AI isn't driving the tool loop.
 */
async function executeToolCall(
	toolCall: ToolCall,
	tools: AgentTool<any>[],
	signal: AbortSignal | undefined,
	emit: EmitFn,
): Promise<ToolResultMessage[]> {
	const tool = tools.find((t) => t.name === toolCall.name);

	emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});

	let result: AgentToolResult;
	let isError = false;

	if (!tool) {
		result = {
			content: [{ type: "text", text: `Tool not found: ${toolCall.name}` }],
			details: {},
		};
		isError = true;
	} else {
		try {
			const validatedArgs = v.parse(tool.parameters, toolCall.arguments);
			result = await tool.execute(
				toolCall.id,
				validatedArgs,
				signal,
				(partialResult) => {
					emit({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
						partialResult,
					});
				},
			);
		} catch (e) {
			result = {
				content: [
					{ type: "text", text: e instanceof Error ? e.message : String(e) },
				],
				details: {},
			};
			isError = true;
		}
	}

	emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	emit({ type: "message_start", message: toolResultMessage });
	emit({ type: "message_end", message: toolResultMessage });

	return [toolResultMessage];
}

// ============================================================================
// Stream processing — consumes TanStack AI stream, builds messages
// ============================================================================

interface ProcessResult {
	messages: AgentMessage[];
	toolResults: ToolResultMessage[];
	lastAssistant: AssistantMessage;
	abortedOrError: boolean;
}

/**
 * Process a full TanStack AI agent stream (may include multiple LLM turns
 * if tools are involved). Builds AssistantMessage + ToolResultMessage objects,
 * emits events for subscribers.
 */
async function processAgentStream(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	streamFn?: StreamFn,
): Promise<ProcessResult> {
	// Apply context transform
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext([...messages], signal);
	}

	// Convert to LLM-compatible messages
	const llmMessages = toModelMessages(messages);

	// Set up tool bridge
	const tracker = createToolCallTracker();
	const toolResultCollector: ToolResultMessage[] = [];
	const tanStackTools = context.tools?.length
		? wrapToolsForTanStack(context.tools, tracker, signal, emit, toolResultCollector)
		: undefined;

	// Build model options
	const modelOptions = config.thinkingLevel && config.thinkingLevel !== "off"
		? toThinkingModelOptions(config.model.provider, config.thinkingLevel)
		: undefined;

	// Build abort controller — create a real one and wire external signal
	let abortController: AbortController | undefined;
	let cleanupAbortListener: (() => void) | undefined;
	if (signal) {
		abortController = new AbortController();
		const onAbort = () => abortController!.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
	}

	// Use custom streamFn or chat() with TanStack's agent loop
	const streamSource: AsyncIterable<StreamChunk> = streamFn
		? streamFn({
				adapter: config.adapter,
				messages: llmMessages,
				systemPrompts: context.systemPrompt
					? [context.systemPrompt]
					: undefined,
				tools: tanStackTools,
				modelOptions,
				temperature: config.temperature,
				maxTokens: config.maxTokens,
				abortController,
			})
		: chat({
				adapter: config.adapter,
				messages: llmMessages,
				systemPrompts: context.systemPrompt
					? [context.systemPrompt]
					: undefined,
				tools: tanStackTools,
				modelOptions,
				temperature: config.temperature,
				maxTokens: config.maxTokens,
				abortController,
				// Let TanStack handle tool-call iterations
				agentLoopStrategy: tanStackTools
					? maxIterations(config.maxTurns ?? 10)
					: () => false,
			});

	// State for multi-turn message accumulation
	const allMessages: AgentMessage[] = [];
	let partial: AssistantMessage = createPartial(config);
	let emittedStart = false;
	let turnCount = 0;
	const partialJsonMap = new Map<string, string>();
	const toolCallIndexMap = new Map<string, number>();

	try {
		for await (const chunk of streamSource) {
			if (signal?.aborted) {
				partial.stopReason = "aborted";
				partial.errorMessage = "Request was aborted";
				break;
			}

			// Detect new LLM turn: RUN_STARTED after a previous turn completed
			// This happens when TanStack re-calls the LLM after tool execution
			if (chunk.type === "RUN_STARTED" && turnCount > 0) {
				// Finalize previous assistant message
				finalizePartial(partial, emittedStart, context, allMessages, emit);
				// Start fresh partial for new turn
				partial = createPartial(config);
				emittedStart = false;
				partialJsonMap.clear();
				toolCallIndexMap.clear();
			}

			// Track tool call IDs for the bridge
			if (chunk.type === "TOOL_CALL_START") {
				tracker.register(chunk.toolCallId, chunk.toolName);
			}

			// Track RUN_STARTED for turn counting
			if (chunk.type === "RUN_STARTED") {
				turnCount++;
			}

			// After TanStack executes a tool, it emits TOOL_CALL_END with result.
			// Our wrapped execute already emitted tool_execution_* events and created
			// ToolResultMessages. The TOOL_CALL_END with result is TanStack's own event
			// after our execute returns — we should skip it to avoid double-processing.
			if (chunk.type === "TOOL_CALL_END" && "result" in chunk && chunk.result !== undefined) {
				// TanStack's post-execution event. Tool results already handled by wrapper.
				// Push tool results into context for next LLM call awareness
				for (const tr of toolResultCollector) {
					if (!allMessages.includes(tr)) {
						context.messages.push(tr);
						allMessages.push(tr);
					}
				}
				continue;
			}

			// Process chunk into partial AssistantMessage
			processChunk(chunk, partial, emit, emittedStart, partialJsonMap, toolCallIndexMap, config.model);

			// Update emittedStart after processing
			if (!emittedStart && (
				chunk.type === "RUN_STARTED" ||
				chunk.type === "TEXT_MESSAGE_START" ||
				chunk.type === "STEP_STARTED" ||
				chunk.type === "TOOL_CALL_START"
			)) {
				emittedStart = true;
			}
		}
	} catch (err: any) {
		partial.stopReason = signal?.aborted ? "aborted" : "error";
		partial.errorMessage = err?.message || String(err);
	} finally {
		cleanupAbortListener?.();
	}

	// Finalize last partial
	finalizePartial(partial, emittedStart, context, allMessages, emit);

	return {
		messages: allMessages,
		toolResults: toolResultCollector,
		lastAssistant: partial,
		abortedOrError: partial.stopReason === "error" || partial.stopReason === "aborted",
	};
}

function createPartial(config: AgentLoopConfig): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function finalizePartial(
	partial: AssistantMessage,
	emittedStart: boolean,
	context: AgentContext,
	allMessages: AgentMessage[],
	emit: EmitFn,
): void {
	if (!emittedStart) {
		emit({ type: "message_start", message: { ...partial } });
	}
	context.messages.push(partial);
	allMessages.push(partial);
	emit({ type: "message_end", message: partial });
}

/**
 * Process a single StreamChunk into the partial AssistantMessage.
 * Emits message_start/message_update events.
 */
function processChunk(
	chunk: StreamChunk,
	partial: AssistantMessage,
	emit: EmitFn,
	emittedStart: boolean,
	partialJsonMap: Map<string, string>,
	toolCallIndexMap: Map<string, number>,
	model: Model,
): void {
	switch (chunk.type) {
		case "RUN_STARTED": {
			if (!emittedStart) {
				emit({ type: "message_start", message: { ...partial } });
			}
			break;
		}

		case "TEXT_MESSAGE_START": {
			if (!emittedStart) {
				emit({ type: "message_start", message: { ...partial } });
			}
			const textIdx = partial.content.length;
			partial.content.push({ type: "text", text: "" });
			emitUpdate(emit, partial, { type: "text_start", contentIndex: textIdx });
			break;
		}

		case "TEXT_MESSAGE_CONTENT": {
			const lastText = partial.content.findLast((c) => c.type === "text");
			if (lastText && lastText.type === "text") {
				lastText.text += chunk.delta;
				const idx = partial.content.lastIndexOf(lastText);
				emitUpdate(emit, partial, {
					type: "text_delta",
					contentIndex: idx,
					delta: chunk.delta,
				});
			}
			break;
		}

		case "TEXT_MESSAGE_END": {
			const endText = partial.content.findLast((c) => c.type === "text");
			if (endText) {
				const idx = partial.content.lastIndexOf(endText);
				emitUpdate(emit, partial, { type: "text_end", contentIndex: idx });
			}
			break;
		}

		case "STEP_STARTED": {
			if (!emittedStart) {
				emit({ type: "message_start", message: { ...partial } });
			}
			const thinkIdx = partial.content.length;
			partial.content.push({ type: "thinking", thinking: "" });
			emitUpdate(emit, partial, { type: "thinking_start", contentIndex: thinkIdx });
			break;
		}

		case "STEP_FINISHED": {
			const lastThinking = partial.content.findLast((c) => c.type === "thinking");
			if (lastThinking && lastThinking.type === "thinking") {
				lastThinking.thinking += chunk.delta;
				const idx = partial.content.lastIndexOf(lastThinking);
				emitUpdate(emit, partial, {
					type: "thinking_delta",
					contentIndex: idx,
					delta: chunk.delta,
				});
				emitUpdate(emit, partial, { type: "thinking_end", contentIndex: idx });
			}
			break;
		}

		case "TOOL_CALL_START": {
			if (!emittedStart) {
				emit({ type: "message_start", message: { ...partial } });
			}
			const tcIdx = partial.content.length;
			partial.content.push({
				type: "toolCall",
				id: chunk.toolCallId,
				name: chunk.toolName,
				arguments: {},
			});
			toolCallIndexMap.set(chunk.toolCallId, tcIdx);
			partialJsonMap.set(chunk.toolCallId, "");
			emitUpdate(emit, partial, { type: "toolcall_start", contentIndex: tcIdx });
			break;
		}

		case "TOOL_CALL_ARGS": {
			const accum =
				(partialJsonMap.get(chunk.toolCallId) || "") + chunk.delta;
			partialJsonMap.set(chunk.toolCallId, accum);

			const tcArgIdx = toolCallIndexMap.get(chunk.toolCallId);
			if (tcArgIdx !== undefined) {
				try {
					const parsed = JSON.parse(accum);
					const tc = partial.content[tcArgIdx];
					if (tc && tc.type === "toolCall") {
						tc.arguments = parsed;
					}
				} catch {
					// Incomplete JSON — keep accumulating
				}
				emitUpdate(emit, partial, {
					type: "toolcall_delta",
					contentIndex: tcArgIdx,
					delta: chunk.delta,
				});
			}
			break;
		}

		case "TOOL_CALL_END": {
			// Only handle the pre-execution end event (no result field)
			const tcEndIdx = toolCallIndexMap.get(chunk.toolCallId);
			if (tcEndIdx !== undefined) {
				const tc = partial.content[tcEndIdx];
				if (tc && tc.type === "toolCall") {
					if (chunk.input !== undefined) {
						tc.arguments = chunk.input as Record<string, unknown>;
					} else {
						const finalJson = partialJsonMap.get(chunk.toolCallId) || "{}";
						try {
							tc.arguments = JSON.parse(finalJson);
						} catch {
							tc.arguments = {};
						}
					}
				}
				emitUpdate(emit, partial, {
					type: "toolcall_end",
					contentIndex: tcEndIdx,
					toolCall: tc as ToolCall,
				});
			}
			break;
		}

		case "RUN_FINISHED": {
			if (chunk.finishReason === "tool_calls") {
				partial.stopReason = "toolUse";
			} else if (chunk.finishReason === "length") {
				partial.stopReason = "length";
			} else {
				partial.stopReason = "stop";
			}
			if (chunk.usage) {
				partial.usage = mapTanStackUsage(model, {
					promptTokens: chunk.usage.promptTokens,
					completionTokens: chunk.usage.completionTokens,
					totalTokens: chunk.usage.totalTokens,
				});
			}
			break;
		}

		case "RUN_ERROR": {
			partial.stopReason = "error";
			partial.errorMessage = chunk.error?.message || "Unknown error";
			break;
		}
	}
}

/**
 * Emit a message_update event with a snapshot of the partial message.
 */
function emitUpdate(
	emit: EmitFn,
	partial: AssistantMessage,
	streamEvent: AssistantStreamEvent,
): void {
	emit({
		type: "message_update",
		message: { ...partial, content: [...partial.content] },
		streamEvent,
	});
}
