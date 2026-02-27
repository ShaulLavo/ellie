import { describe, expect, test } from 'bun:test'
import {
	estimateTokens,
	estimateMessageTokens,
	trimMessages,
	isApproachingLimit
} from '../src/context-recovery'
import type { ContextRecoveryOptions } from '../src/context-recovery'
import type {
	AgentMessage,
	AssistantMessage,
	UserMessage,
	ToolResultMessage
} from '../src/types'

// ============================================================================
// Helpers
// ============================================================================

function makeUser(
	text: string,
	timestamp = Date.now()
): UserMessage {
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		timestamp
	}
}

function makeAssistant(
	text: string,
	inputTokens = 0,
	timestamp = Date.now()
): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		provider: 'anthropic',
		model: 'claude-sonnet-4-6',
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0
			}
		},
		stopReason: 'stop',
		timestamp
	}
}

function makeAssistantWithToolCalls(
	toolCalls: Array<{
		id: string
		name: string
		args: Record<string, unknown>
	}>,
	text = '',
	inputTokens = 0
): AssistantMessage {
	return {
		role: 'assistant',
		content: [
			...(text ? [{ type: 'text' as const, text }] : []),
			...toolCalls.map(tc => ({
				type: 'toolCall' as const,
				id: tc.id,
				name: tc.name,
				arguments: tc.args
			}))
		],
		provider: 'anthropic',
		model: 'claude-sonnet-4-6',
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0
			}
		},
		stopReason: 'toolUse',
		timestamp: Date.now()
	}
}

function makeToolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false
): ToolResultMessage {
	return {
		role: 'toolResult',
		toolCallId,
		toolName,
		content: [{ type: 'text', text }],
		isError,
		timestamp: Date.now()
	}
}

// ============================================================================
// estimateMessageTokens
// ============================================================================

describe('estimateMessageTokens', () => {
	test('estimates text message tokens', () => {
		const msg = makeUser('hello world') // 11 chars
		const tokens = estimateMessageTokens(msg, 4)
		// 4 overhead + ceil(11/4) = 4 + 3 = 7
		expect(tokens).toBe(7)
	})

	test('estimates longer text', () => {
		const msg = makeUser('x'.repeat(400)) // 400 chars
		const tokens = estimateMessageTokens(msg, 4)
		// 4 overhead + ceil(400/4) = 4 + 100 = 104
		expect(tokens).toBe(104)
	})

	test('estimates thinking content', () => {
		const msg: AssistantMessage = {
			...makeAssistant('', 0),
			content: [
				{ type: 'thinking', thinking: 'x'.repeat(200) },
				{ type: 'text', text: 'y'.repeat(100) }
			]
		}
		const tokens = estimateMessageTokens(msg, 4)
		// 4 overhead + ceil((200+100)/4) = 4 + 75 = 79
		expect(tokens).toBe(79)
	})

	test('estimates tool call content', () => {
		const msg = makeAssistantWithToolCalls([
			{
				id: 'tc1',
				name: 'readFile',
				args: { path: '/foo/bar.ts' }
			}
		])
		const tokens = estimateMessageTokens(msg, 4)
		// Tool name "readFile" = 8 chars + JSON args = ~24 chars
		expect(tokens).toBeGreaterThan(4) // At least overhead
	})

	test('handles configurable charsPerToken', () => {
		const msg = makeUser('x'.repeat(300))
		const tokens3 = estimateMessageTokens(msg, 3)
		const tokens4 = estimateMessageTokens(msg, 4)
		// 3 chars/token should give more tokens than 4 chars/token
		expect(tokens3).toBeGreaterThan(tokens4)
	})

	test('adds overhead for toolResult messages', () => {
		const msg = makeToolResult(
			'tc1',
			'readFile',
			'file contents'
		)
		const tokens = estimateMessageTokens(msg, 4)
		// Should include toolName length + toolCallId overhead (~40)
		expect(tokens).toBeGreaterThan(10)
	})
})

// ============================================================================
// estimateTokens
// ============================================================================

describe('estimateTokens', () => {
	test('uses real API token counts when available', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeAssistant('world', 5000) // Real count: 5000 input tokens
		]
		const tokens = estimateTokens(messages)
		// Should use the real 5000, no additional messages after it
		expect(tokens).toBe(5000)
	})

	test('adds heuristic estimate for messages after last assistant', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeAssistant('world', 5000), // Real count: 5000
			makeUser('x'.repeat(400)) // After the assistant → heuristic
		]
		const tokens = estimateTokens(messages)
		// 5000 + heuristic for the user message (~104)
		expect(tokens).toBeGreaterThan(5000)
		expect(tokens).toBeLessThan(5200)
	})

	test('falls back to full heuristic when no usage data', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeAssistant('world', 0) // No real count
		]
		const tokens = estimateTokens(messages)
		// Pure heuristic — should be small
		expect(tokens).toBeGreaterThan(0)
		expect(tokens).toBeLessThan(100)
	})

	test('handles empty message array', () => {
		expect(estimateTokens([])).toBe(0)
	})

	test('sums all messages with heuristic when no assistant messages', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeUser('world')
		]
		const tokens = estimateTokens(messages)
		expect(tokens).toBeGreaterThan(0)
	})
})

// ============================================================================
// trimMessages
// ============================================================================

describe('trimMessages', () => {
	const defaultOpts: ContextRecoveryOptions = {
		contextWindow: 1000, // Small window for testing
		safetyMargin: 0.85,
		minPreservedMessages: 4,
		charsPerToken: 4
	}

	test('returns unchanged when within budget', () => {
		const messages: AgentMessage[] = [
			makeUser('hi'),
			makeAssistant('hello')
		]
		const result = trimMessages(messages, defaultOpts)
		expect(result.removedCount).toBe(0)
		expect(result.messages.length).toBe(2)
	})

	test('trims oldest messages when over budget', () => {
		// Create messages that exceed 850 tokens (1000 * 0.85)
		const messages: AgentMessage[] = [
			makeUser('x'.repeat(1000)), // ~254 tokens
			makeAssistant('y'.repeat(1000)), // ~254 tokens
			makeUser('z'.repeat(1000)), // ~254 tokens
			makeAssistant('w'.repeat(1000)), // ~254 tokens — total ~1016
			makeUser('recent'), // Keep
			makeAssistant('latest') // Keep
		]
		const result = trimMessages(messages, defaultOpts)
		expect(result.removedCount).toBeGreaterThan(0)
		expect(result.messages.length).toBeLessThan(
			messages.length
		)
		// Recent messages should be preserved
		const lastMsg =
			result.messages[result.messages.length - 1]
		expect(lastMsg.role).toBe('assistant')
	})

	test('always preserves at least minPreservedMessages', () => {
		const messages: AgentMessage[] = [
			makeUser('x'.repeat(2000)),
			makeAssistant('y'.repeat(2000)),
			makeUser('z'.repeat(2000)),
			makeAssistant('w'.repeat(2000)),
			makeUser('keep1'),
			makeAssistant('keep2'),
			makeUser('keep3'),
			makeAssistant('keep4')
		]
		const result = trimMessages(messages, {
			...defaultOpts,
			minPreservedMessages: 4
		})
		expect(result.messages.length).toBeGreaterThanOrEqual(4)
	})

	test('removes orphaned toolResult messages', () => {
		const messages: AgentMessage[] = [
			makeUser('do something'),
			makeAssistantWithToolCalls([
				{
					id: 'tc1',
					name: 'readFile',
					args: { path: '/foo' }
				}
			]),
			makeToolResult('tc1', 'readFile', 'file contents'),
			makeUser('x'.repeat(2000)), // Force trimming
			makeAssistant('final answer', 0),
			makeUser('ok'),
			makeAssistant('done')
		]
		const result = trimMessages(messages, {
			...defaultOpts,
			contextWindow: 500 // Force aggressive trimming
		})

		// Orphaned toolResult (whose assistant was trimmed) should be removed
		const toolResults = result.messages.filter(
			m => m.role === 'toolResult'
		)
		for (const tr of toolResults) {
			const toolMsg = tr as ToolResultMessage
			// Verify the parent assistant message with this toolCallId exists
			const hasParent = result.messages.some(
				m =>
					m.role === 'assistant' &&
					(m as AssistantMessage).content.some(
						b =>
							b.type === 'toolCall' &&
							b.id === toolMsg.toolCallId
					)
			)
			expect(hasParent).toBe(true)
		}
	})

	test('handles all messages fitting in budget', () => {
		const messages: AgentMessage[] = [
			makeUser('hi'),
			makeAssistant('hello')
		]
		const result = trimMessages(messages, {
			...defaultOpts,
			contextWindow: 100000
		})
		expect(result.removedCount).toBe(0)
		expect(result.messages).toEqual(messages)
	})

	test('handles single message', () => {
		const messages: AgentMessage[] = [makeUser('hello')]
		const result = trimMessages(messages, defaultOpts)
		expect(result.messages.length).toBe(1)
	})

	test('handles empty messages', () => {
		const result = trimMessages([], defaultOpts)
		expect(result.messages).toEqual([])
		expect(result.removedCount).toBe(0)
	})

	test('returns estimated tokens in result', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeAssistant('world')
		]
		const result = trimMessages(messages, defaultOpts)
		expect(result.estimatedTokens).toBeGreaterThan(0)
	})
})

// ============================================================================
// isApproachingLimit
// ============================================================================

describe('isApproachingLimit', () => {
	test('returns false when well within budget', () => {
		const messages: AgentMessage[] = [
			makeUser('hello'),
			makeAssistant('world')
		]
		expect(isApproachingLimit(messages, 100000)).toBe(false)
	})

	test('returns true when over budget', () => {
		const messages: AgentMessage[] = [
			makeUser('x'.repeat(4000)) // ~1004 tokens at 4 chars/token
		]
		expect(isApproachingLimit(messages, 1000)).toBe(true)
	})

	test('respects custom safetyMargin', () => {
		const messages: AgentMessage[] = [
			makeUser('x'.repeat(3200)) // ~804 tokens
		]
		// At 0.85 margin: budget = 850. 804 < 850 → false
		expect(isApproachingLimit(messages, 1000, 0.85)).toBe(
			false
		)
		// At 0.7 margin: budget = 700. 804 > 700 → true
		expect(isApproachingLimit(messages, 1000, 0.7)).toBe(
			true
		)
	})

	test('respects custom charsPerToken', () => {
		const messages: AgentMessage[] = [
			makeUser('x'.repeat(3000))
		]
		// At 4 chars/token: ~754 tokens. Budget=850 → false
		expect(
			isApproachingLimit(messages, 1000, 0.85, 4)
		).toBe(false)
		// At 3 chars/token: ~1004 tokens. Budget=850 → true
		expect(
			isApproachingLimit(messages, 1000, 0.85, 3)
		).toBe(true)
	})
})

// ============================================================================
// Orphan prevention edge cases
// ============================================================================

describe('orphan prevention', () => {
	test('keeps assistant with text even when tool results are missing', () => {
		// When trimming removes tool results but the assistant also has text
		const messages: AgentMessage[] = [
			makeUser('start'),
			makeAssistantWithToolCalls(
				[{ id: 'tc1', name: 'search', args: {} }],
				'I will search for you' // Has meaningful text
			)
		]

		const result = trimMessages(messages, {
			contextWindow: 100000,
			safetyMargin: 0.85,
			minPreservedMessages: 4,
			charsPerToken: 4
		})

		// Assistant with text should be kept even without tool results
		const assistants = result.messages.filter(
			m => m.role === 'assistant'
		)
		expect(assistants.length).toBe(1)
	})

	test('preserves complete tool call/result pairs', () => {
		const messages: AgentMessage[] = [
			makeUser('help'),
			makeAssistantWithToolCalls([
				{
					id: 'tc1',
					name: 'readFile',
					args: { path: '/a' }
				}
			]),
			makeToolResult('tc1', 'readFile', 'contents of a'),
			makeAssistant('Here is the result')
		]

		const result = trimMessages(messages, {
			contextWindow: 100000,
			safetyMargin: 0.85,
			minPreservedMessages: 10,
			charsPerToken: 4
		})

		// Everything should be preserved since we're within budget
		expect(result.messages.length).toBe(4)
	})
})
