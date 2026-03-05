import * as v from 'valibot'
import {
	truncateToolResult,
	needsTruncation
} from '../tool-safety'
import type { ToolLoopDetector } from '../tool-loop-detection'
import type {
	AgentTool,
	AgentToolResult,
	ToolResultMessage
} from '../types'
import type { EmitFn } from './types'

/**
 * Tracks TOOL_CALL_START events so wrapped execute functions can
 * correlate which toolCallId they're executing for.
 * Safe because TanStack emits all TOOL_CALL_START events for an
 * iteration before calling any execute functions.
 */
export interface ToolCallTracker {
	register(toolCallId: string, toolName: string): void
	dequeue(toolName: string): string
}

export function createToolCallTracker(): ToolCallTracker {
	const pending = new Map<string, string[]>()
	return {
		register(toolCallId: string, toolName: string) {
			let ids = pending.get(toolName)
			if (!ids) {
				ids = []
				pending.set(toolName, ids)
			}
			ids.push(toolCallId)
		},
		dequeue(toolName: string): string {
			const ids = pending.get(toolName)
			if (ids && ids.length > 0) {
				return ids.shift()!
			}
			return `unknown_${Date.now()}`
		}
	}
}

/**
 * Tool names reserved by Anthropic as built-in server tools. TanStack AI's
 * Anthropic adapter intercepts these and converts them to server tool types
 * instead of custom tools — our execute function never gets called.
 */
const ANTHROPIC_RESERVED_TOOL_NAMES = new Set([
	'bash',
	'code_execution',
	'computer',
	'memory',
	'str_replace_editor',
	'web_fetch',
	'web_search'
])

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
export function wrapToolsForTanStack(
	tools: AgentTool[],
	tracker: ToolCallTracker,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	toolResultCollector: ToolResultMessage[],
	maxToolResultChars?: number,
	loopDetector?: ToolLoopDetector
) {
	for (const tool of tools) {
		if (ANTHROPIC_RESERVED_TOOL_NAMES.has(tool.name)) {
			throw new Error(
				`Tool name "${tool.name}" collides with an Anthropic built-in server tool. ` +
					`TanStack AI will silently convert it, bypassing our execute function. ` +
					`Rename the tool to avoid this collision. ` +
					`Reserved names: ${[...ANTHROPIC_RESERVED_TOOL_NAMES].join(', ')}`
			)
		}
	}

	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		execute: async (args: unknown) => {
			const toolCallId = tracker.dequeue(tool.name)

			// Check for tool loop before execution
			if (loopDetector) {
				const loopCheck = loopDetector.record(
					tool.name,
					args
				)
				if (loopCheck.detected) {
					emit({
						type: 'tool_loop_detected',
						pattern: loopCheck.pattern!,
						toolName: tool.name,
						message: loopCheck.message!
					})

					emit({
						type: 'tool_execution_start',
						toolCallId,
						toolName: tool.name,
						args
					})

					const loopResult: AgentToolResult = {
						content: [
							{ type: 'text', text: loopCheck.message! }
						],
						details: {}
					}

					emit({
						type: 'tool_execution_end',
						toolCallId,
						toolName: tool.name,
						result: loopResult,
						isError: true
					})

					const toolResultMessage: ToolResultMessage = {
						role: 'toolResult',
						toolCallId,
						toolName: tool.name,
						content: loopResult.content,
						details: loopResult.details,
						isError: true,
						timestamp: Date.now()
					}
					toolResultCollector.push(toolResultMessage)
					emit({
						type: 'message_start',
						message: toolResultMessage
					})
					emit({
						type: 'message_end',
						message: toolResultMessage
					})

					return { output: loopCheck.message! }
				}
			}

			emit({
				type: 'tool_execution_start',
				toolCallId,
				toolName: tool.name,
				args
			})

			const startedAt = Date.now()
			let result: AgentToolResult
			let isError = false

			try {
				const validatedArgs = v.parse(tool.parameters, args)
				result = await tool.execute(
					toolCallId,
					validatedArgs,
					signal,
					partialResult => {
						emit({
							type: 'tool_execution_update',
							toolCallId,
							toolName: tool.name,
							args,
							partialResult
						})
					}
				)
			} catch (e) {
				result = {
					content: [
						{
							type: 'text',
							text:
								e instanceof Error ? e.message : String(e)
						}
					],
					details: {}
				}
				isError = true
			}

			// Truncate oversized tool results
			if (
				!isError &&
				maxToolResultChars &&
				needsTruncation(result, maxToolResultChars)
			) {
				result = truncateToolResult(
					result,
					maxToolResultChars
				)
			}

			const elapsedMs = Date.now() - startedAt

			emit({
				type: 'tool_execution_end',
				toolCallId,
				toolName: tool.name,
				result,
				isError,
				elapsedMs
			})

			// Record outcome for loop detection
			if (loopDetector) {
				loopDetector.recordOutcome(
					tool.name,
					args,
					result.content
				)
			}

			// Create and emit ToolResultMessage for persistence
			const toolResultMessage: ToolResultMessage = {
				role: 'toolResult',
				toolCallId,
				toolName: tool.name,
				content: result.content,
				details: result.details,
				isError,
				timestamp: Date.now()
			}
			toolResultCollector.push(toolResultMessage)
			emit({
				type: 'message_start',
				message: toolResultMessage
			})
			emit({
				type: 'message_end',
				message: toolResultMessage
			})

			// Return as object for TanStack's conversation history.
			// IMPORTANT: Must NOT return a plain string — TanStack's
			// executeToolCalls() does JSON.parse() on string returns,
			// which would fail on non-JSON tool output (e.g. shell text).
			// Returning an object bypasses the JSON.parse path entirely.
			const textResult = result.content
				.map(c => (c.type === 'text' ? c.text : ''))
				.join('')
			return { output: textResult }
		}
	}))
}
