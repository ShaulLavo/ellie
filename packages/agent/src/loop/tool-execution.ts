import * as v from 'valibot'
import type { BlobSink, TraceScope } from '@ellie/trace'
import {
	truncateToolResult,
	truncateToolResultWithBlob,
	needsTruncation
} from '../tool-safety'
import type { ToolLoopDetector } from '../tool-loop-detection'
import type {
	AgentTool,
	AgentToolResult,
	ToolCall,
	ToolResultMessage
} from '../types'
import type { EmitFn } from './types'

/**
 * Execute a single tool call manually. Used for the streamFn path
 * where TanStack AI isn't driving the tool loop.
 */
export async function executeToolCall(
	toolCall: ToolCall,
	tools: AgentTool[],
	signal: AbortSignal | undefined,
	emit: EmitFn,
	maxToolResultChars?: number,
	loopDetector?: ToolLoopDetector,
	blobSink?: BlobSink,
	traceScope?: TraceScope
): Promise<ToolResultMessage[]> {
	const tool = tools.find(t => t.name === toolCall.name)

	// Check for tool loop before execution
	if (loopDetector) {
		const loopCheck = loopDetector.record(
			toolCall.name,
			toolCall.arguments
		)
		if (loopCheck.detected) {
			emit({
				type: 'tool_loop_detected',
				pattern: loopCheck.pattern!,
				toolName: toolCall.name,
				message: loopCheck.message!
			})

			emit({
				type: 'tool_execution_start',
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments
			})

			const loopResult: AgentToolResult = {
				content: [
					{ type: 'text', text: loopCheck.message! }
				],
				details: {}
			}

			emit({
				type: 'tool_execution_end',
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				result: loopResult,
				isError: true
			})

			const toolResultMessage: ToolResultMessage = {
				role: 'toolResult',
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: loopResult.content,
				details: loopResult.details,
				isError: true,
				timestamp: Date.now()
			}

			emit({
				type: 'message_start',
				message: toolResultMessage
			})
			emit({
				type: 'message_end',
				message: toolResultMessage
			})

			return [toolResultMessage]
		}
	}

	emit({
		type: 'tool_execution_start',
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments
	})

	const startedAt = Date.now()
	let result: AgentToolResult
	let isError = false

	if (!tool) {
		result = {
			content: [
				{
					type: 'text',
					text: `Tool not found: ${toolCall.name}`
				}
			],
			details: {}
		}
		isError = true
	} else {
		try {
			const validatedArgs = v.parse(
				tool.parameters,
				toolCall.arguments
			)
			result = await tool.execute(
				toolCall.id,
				validatedArgs,
				signal,
				partialResult => {
					emit({
						type: 'tool_execution_update',
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
						partialResult
					})
				}
			)
		} catch (e) {
			result = {
				content: [
					{
						type: 'text',
						text: e instanceof Error ? e.message : String(e)
					}
				],
				details: {}
			}
			isError = true
		}
	}

	// Truncate oversized tool results
	if (
		!isError &&
		maxToolResultChars &&
		needsTruncation(result, maxToolResultChars)
	) {
		if (blobSink && traceScope) {
			// Blob-backed overflow (fail-closed)
			try {
				result = await truncateToolResultWithBlob(
					result,
					maxToolResultChars,
					{
						blobSink,
						traceScope,
						toolCallId: toolCall.id
					}
				)
			} catch (blobErr) {
				// Fail closed: blob write failed, convert to error result
				result = {
					content: [
						{
							type: 'text',
							text: `Tool result overflow failed: ${blobErr instanceof Error ? blobErr.message : String(blobErr)}`
						}
					],
					details: {}
				}
				isError = true
			}
		} else {
			// No blob storage — truncate without overflow storage
			result = truncateToolResult(
				result,
				maxToolResultChars
			)
		}
	}

	const elapsedMs = Date.now() - startedAt

	emit({
		type: 'tool_execution_end',
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
		elapsedMs
	})

	// Record outcome for loop detection
	if (loopDetector) {
		loopDetector.recordOutcome(
			toolCall.name,
			toolCall.arguments,
			result.content
		)
	}

	const toolResultMessage: ToolResultMessage = {
		role: 'toolResult',
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now()
	}

	emit({
		type: 'message_start',
		message: toolResultMessage
	})
	emit({ type: 'message_end', message: toolResultMessage })

	return [toolResultMessage]
}
