/**
 * Agent loop — orchestrates multi-turn LLM conversations with tool execution.
 *
 * Transforms to ModelMessage[] only at the LLM call boundary.
 * Handles steering (mid-execution interrupts) and follow-up messages.
 */

import { chat, type StreamChunk } from "@tanstack/ai";
import { mapTanStackUsage, toThinkingModelOptions } from "@ellie/ai";
import type { Usage } from "@ellie/ai";
import * as v from "valibot";
import { EventStream } from "./event-stream";
import { convertAgentToolsToTanStack } from "./messages";
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
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding new messages.
 * Used for retries — context already has user message or tool results.
 *
 * The last message must convert to a user or toolResult via convertToLlm.
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
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		emit({ type: "agent_start" });
		emit({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, emit, streamFn);
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

/**
 * Create an emit function that pushes to the EventStream and calls onEvent.
 */
function createEmitter(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): EmitFn {
	return (event: AgentEvent) => {
		stream.push(event);
		config.onEvent?.(event);
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

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
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

	// Outer loop: continues when follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					emit({ type: "message_start", message });
					emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(
				currentContext,
				config,
				signal,
				emit,
				streamFn,
			);
			newMessages.push(message);

			if (
				message.stopReason === "error" ||
				message.stopReason === "aborted"
			) {
				emit({ type: "turn_end", message, toolResults: [] });
				emit({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter(
				(c): c is ToolCall => c.type === "toolCall",
			);
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					emit,
					config.getSteeringMessages,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			emit({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	emit({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * Converts AgentMessage[] → ModelMessage[] at the call boundary.
 * Consumes AG-UI StreamChunk events and builds an AssistantMessage.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured
	// Pass a defensive copy so the callback isn't affected by later mutations
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext([...messages], signal);
	}

	// Convert to LLM-compatible messages
	const llmMessages = await config.convertToLlm(messages);

	// Convert tools
	const tanStackTools = context.tools
		? convertAgentToolsToTanStack(context.tools)
		: undefined;

	// Build model options with thinking support
	let modelOptions = config.thinkingLevel && config.thinkingLevel !== "off"
		? toThinkingModelOptions(config.model.provider, config.thinkingLevel)
		: undefined;

	// Build abort controller
	const abortController = signal
		? { abort: () => {}, signal } as AbortController
		: undefined;

	// Use custom streamFn or default chat()
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
				// Disable TanStack AI's built-in agent loop — we handle it ourselves
				agentLoopStrategy: () => false,
			});

	// Build partial AssistantMessage from AG-UI events
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	let emittedStart = false;
	// Track partial JSON for tool call arguments
	const partialJsonMap = new Map<string, string>();
	// Map toolCallId → contentIndex for tool call events
	const toolCallIndexMap = new Map<string, number>();

	try {
		for await (const chunk of streamSource) {
			if (signal?.aborted) {
				partial.stopReason = "aborted";
				partial.errorMessage = "Request was aborted";
				break;
			}

			switch (chunk.type) {
				case "RUN_STARTED": {
					if (!emittedStart) {
						emittedStart = true;
						emit({
							type: "message_start",
							message: { ...partial },
						});
					}
					break;
				}

				case "TEXT_MESSAGE_START": {
					if (!emittedStart) {
						emittedStart = true;
						emit({
							type: "message_start",
							message: { ...partial },
						});
					}
					// Add empty text content block
					const textIdx = partial.content.length;
					partial.content.push({ type: "text", text: "" });
					const textStartEvent: AssistantStreamEvent = {
						type: "text_start",
						contentIndex: textIdx,
					};
					emit({
						type: "message_update",
						message: { ...partial, content: [...partial.content] },
						streamEvent: textStartEvent,
					});
					break;
				}

				case "TEXT_MESSAGE_CONTENT": {
					// Append delta to last text content block
					const lastText = partial.content.findLast((c) => c.type === "text");
					if (lastText && lastText.type === "text") {
						lastText.text += chunk.delta;
						const idx = partial.content.lastIndexOf(lastText);
						const textDeltaEvent: AssistantStreamEvent = {
							type: "text_delta",
							contentIndex: idx,
							delta: chunk.delta,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: textDeltaEvent,
						});
					}
					break;
				}

				case "TEXT_MESSAGE_END": {
					const endText = partial.content.findLast((c) => c.type === "text");
					if (endText) {
						const idx = partial.content.lastIndexOf(endText);
						const textEndEvent: AssistantStreamEvent = {
							type: "text_end",
							contentIndex: idx,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: textEndEvent,
						});
					}
					break;
				}

				case "STEP_STARTED": {
					if (!emittedStart) {
						emittedStart = true;
						emit({
							type: "message_start",
							message: { ...partial },
						});
					}
					// Add empty thinking content block
					const thinkIdx = partial.content.length;
					partial.content.push({ type: "thinking", thinking: "" });
					const thinkStartEvent: AssistantStreamEvent = {
						type: "thinking_start",
						contentIndex: thinkIdx,
					};
					emit({
						type: "message_update",
						message: { ...partial, content: [...partial.content] },
						streamEvent: thinkStartEvent,
					});
					break;
				}

				case "STEP_FINISHED": {
					const lastThinking = partial.content.findLast(
						(c) => c.type === "thinking",
					);
					if (lastThinking && lastThinking.type === "thinking") {
						lastThinking.thinking += chunk.delta;
						const idx = partial.content.lastIndexOf(lastThinking);
						const thinkDeltaEvent: AssistantStreamEvent = {
							type: "thinking_delta",
							contentIndex: idx,
							delta: chunk.delta,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: thinkDeltaEvent,
						});
						const thinkEndEvent: AssistantStreamEvent = {
							type: "thinking_end",
							contentIndex: idx,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: thinkEndEvent,
						});
					}
					break;
				}

				case "TOOL_CALL_START": {
					if (!emittedStart) {
						emittedStart = true;
						emit({
							type: "message_start",
							message: { ...partial },
						});
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
					const tcStartEvent: AssistantStreamEvent = {
						type: "toolcall_start",
						contentIndex: tcIdx,
					};
					emit({
						type: "message_update",
						message: { ...partial, content: [...partial.content] },
						streamEvent: tcStartEvent,
					});
					break;
				}

				case "TOOL_CALL_ARGS": {
					const accum =
						(partialJsonMap.get(chunk.toolCallId) || "") + chunk.delta;
					partialJsonMap.set(chunk.toolCallId, accum);

					const tcArgIdx = toolCallIndexMap.get(chunk.toolCallId);
					if (tcArgIdx !== undefined) {
						// Try to parse accumulated JSON
						try {
							const parsed = JSON.parse(accum);
							const tc = partial.content[tcArgIdx];
							if (tc && tc.type === "toolCall") {
								tc.arguments = parsed;
							}
						} catch {
							// Incomplete JSON — that's fine, keep accumulating
						}

						const tcDeltaEvent: AssistantStreamEvent = {
							type: "toolcall_delta",
							contentIndex: tcArgIdx,
							delta: chunk.delta,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: tcDeltaEvent,
						});
					}
					break;
				}

				case "TOOL_CALL_END": {
					const tcEndIdx = toolCallIndexMap.get(chunk.toolCallId);
					if (tcEndIdx !== undefined) {
						// Use final input if available, otherwise parse accumulated JSON
						const tc = partial.content[tcEndIdx];
						if (tc && tc.type === "toolCall") {
							if (chunk.input !== undefined) {
								tc.arguments = chunk.input as Record<string, unknown>;
							} else {
								const finalJson =
									partialJsonMap.get(chunk.toolCallId) || "{}";
								try {
									tc.arguments = JSON.parse(finalJson);
								} catch {
									tc.arguments = {};
								}
							}
						}

						const tcEndEvent: AssistantStreamEvent = {
							type: "toolcall_end",
							contentIndex: tcEndIdx,
							toolCall: tc as ToolCall,
						};
						emit({
							type: "message_update",
							message: { ...partial, content: [...partial.content] },
							streamEvent: tcEndEvent,
						});
					}
					break;
				}

				case "RUN_FINISHED": {
					// Map finish reason
					if (chunk.finishReason === "tool_calls") {
						partial.stopReason = "toolUse";
					} else if (chunk.finishReason === "length") {
						partial.stopReason = "length";
					} else {
						partial.stopReason = "stop";
					}

					// Map usage
					if (chunk.usage) {
						partial.usage = mapTanStackUsage(config.model, {
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
	} catch (err: any) {
		partial.stopReason = signal?.aborted ? "aborted" : "error";
		partial.errorMessage = err?.message || String(err);
	}

	// Ensure message_start was emitted
	if (!emittedStart) {
		emit({ type: "message_start", message: { ...partial } });
	}

	// Finalize: add to context and emit message_end
	context.messages.push(partial);
	emit({ type: "message_end", message: partial });

	return partial;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{
	toolResults: ToolResultMessage[];
	steeringMessages?: AgentMessage[];
}> {
	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCall => c.type === "toolCall",
	);
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const tool = tools?.find((t) => t.name === toolCall.name);

		emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: AgentToolResult;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			// Validate arguments with Valibot
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

		results.push(toolResultMessage);
		emit({ type: "message_start", message: toolResultMessage });
		emit({ type: "message_end", message: toolResultMessage });

		// Check for steering messages — skip remaining tools if user interrupted
		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, emit));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

function skipToolCall(
	toolCall: ToolCall,
	emit: EmitFn,
): ToolResultMessage {
	const result: AgentToolResult = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	emit({ type: "message_start", message: toolResultMessage });
	emit({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
