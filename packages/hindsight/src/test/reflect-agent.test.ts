import { describe, it, expect } from 'bun:test'
import {
	_cleanAnswerText,
	_cleanDoneAnswer,
	_normalizeToolName,
	_isDoneTool,
	_runReflectAgentLoopForTesting,
	type ReflectAgentToolCallResultLike
} from '../reflect'

describe('cleanAnswerText', () => {
	it('strips done() call from end of text', () => {
		const text = `The team's OKRs focus on performance.done({"answer":"The team's OKRs","memory_ids":[]})`
		const cleaned = _cleanAnswerText(text)
		expect(cleaned).toBe(
			"The team's OKRs focus on performance."
		)
		expect(cleaned.includes('done(')).toBe(false)
	})

	it('strips done() call with whitespace', () => {
		const text = `Answer text here. done( {"answer": "short", "memory_ids": []} )`
		const cleaned = _cleanAnswerText(text)
		expect(cleaned).toBe('Answer text here.')
	})

	it('preserves text without done() call', () => {
		const text =
			'This is a normal answer without any tool calls.'
		const cleaned = _cleanAnswerText(text)
		expect(cleaned).toBe(text)
	})

	it("preserves 'done' word in regular text", () => {
		const text =
			'The task is done and completed successfully.'
		const cleaned = _cleanAnswerText(text)
		expect(cleaned).toBe(text)
	})

	it('handles empty text', () => {
		expect(_cleanAnswerText('')).toBe('')
	})

	it('strips multiline done() call', () => {
		const text = `Summary of findings.done({
      "answer": "Summary",
      "memory_ids": ["id1", "id2"]
    })`
		const cleaned = _cleanAnswerText(text)
		expect(cleaned).toBe('Summary of findings.')
	})
})

describe('cleanDoneAnswer', () => {
	it('cleans answer with leaked JSON code block at end', () => {
		const text = `The user's favorite color is blue.

\`\`\`json
{"observation_ids": ["obs-1", "obs-2"]}
\`\`\``
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe(
			"The user's favorite color is blue."
		)
		expect(cleaned.includes('observation_ids')).toBe(false)
	})

	it('cleans answer with leaked memory_ids code block', () => {
		const text = `Here is the answer.

\`\`\`json
{"memory_ids": ["mem-1"]}
\`\`\``
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe('Here is the answer.')
	})

	it('cleans raw JSON object at end of answer', () => {
		const text = `The answer is 42. {"observation_ids": ["obs-1"]}`
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe('The answer is 42.')
	})

	it('cleans trailing IDs pattern', () => {
		const text = `This is the answer.

observation_ids: ["obs-1", "obs-2"]`
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe('This is the answer.')
	})

	it('cleans memory_ids equals pattern at end of answer', () => {
		const text = `Answer text here.
memory_ids = ["mem-1"]`
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe('Answer text here.')
	})

	it('preserves normal answer without leaked output', () => {
		const text =
			'This is a normal answer about observation strategies.'
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe(text)
	})

	it('handles empty answer (returns empty string)', () => {
		expect(_cleanDoneAnswer('')).toBe('')
	})

	it("preserves 'observation' word in regular text content", () => {
		const text =
			'Based on my observation, the user prefers dark mode.'
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned).toBe(text)
	})

	it('handles multiline with markdown', () => {
		const text = `Summary:
- Point 1
- Point 2

\`\`\`json
{"mental_model_ids": ["mm-1"]}
\`\`\``
		const cleaned = _cleanDoneAnswer(text)
		expect(cleaned.includes('Point 1')).toBe(true)
		expect(cleaned.includes('Point 2')).toBe(true)
		expect(cleaned.includes('mental_model_ids')).toBe(false)
	})
})

describe('Tool name normalization', () => {
	it('standard names pass through unchanged', () => {
		expect(_normalizeToolName('done')).toBe('done')
		expect(_normalizeToolName('recall')).toBe('recall')
		expect(_normalizeToolName('search_mental_models')).toBe(
			'search_mental_models'
		)
		expect(_normalizeToolName('search_observations')).toBe(
			'search_observations'
		)
		expect(_normalizeToolName('expand')).toBe('expand')
	})

	it("normalizes 'functions.' prefix", () => {
		expect(_normalizeToolName('functions.done')).toBe(
			'done'
		)
		expect(_normalizeToolName('functions.recall')).toBe(
			'recall'
		)
		expect(
			_normalizeToolName('functions.search_mental_models')
		).toBe('search_mental_models')
	})

	it("normalizes 'call=' prefix", () => {
		expect(_normalizeToolName('call=done')).toBe('done')
		expect(_normalizeToolName('call=recall')).toBe('recall')
	})

	it("normalizes 'call=functions.' prefix", () => {
		expect(_normalizeToolName('call=functions.done')).toBe(
			'done'
		)
		expect(
			_normalizeToolName('call=functions.recall')
		).toBe('recall')
		expect(
			_normalizeToolName(
				'call=functions.search_observations'
			)
		).toBe('search_observations')
	})

	it('normalizes special token suffix', () => {
		expect(
			_normalizeToolName('done<|channel|>commentary')
		).toBe('done')
		expect(_normalizeToolName('recall<|endoftext|>')).toBe(
			'recall'
		)
		expect(
			_normalizeToolName(
				'search_observations<|im_end|>extra'
			)
		).toBe('search_observations')
	})

	it('_isDoneTool recognizes done variants', () => {
		expect(_isDoneTool('done')).toBe(true)
		expect(_isDoneTool('recall')).toBe(false)
		expect(_isDoneTool('functions.done')).toBe(true)
		expect(_isDoneTool('call=done')).toBe(true)
		expect(_isDoneTool('call=functions.done')).toBe(true)
		expect(_isDoneTool('done<|channel|>commentary')).toBe(
			true
		)
		expect(_isDoneTool('done<|endoftext|>')).toBe(true)
		expect(_isDoneTool('functions.recall')).toBe(false)
		expect(_isDoneTool('call=functions.recall')).toBe(false)
		expect(_isDoneTool('recall<|channel|>done')).toBe(false)
	})
})

describe('Reflect agent with mocked LLM', () => {
	type ToolCall = {
		id: string
		name: string
		arguments: Record<string, unknown>
	}

	function createLoop(
		calls: ToolCall[][],
		tools?: Record<
			string,
			(args: Record<string, unknown>) => Promise<unknown>
		>
	) {
		let index = 0
		const callWithTools =
			async (): Promise<ReflectAgentToolCallResultLike> => ({
				toolCalls:
					calls[Math.min(index++, calls.length - 1)] ?? [],
				finishReason: 'tool_calls'
			})
		return _runReflectAgentLoopForTesting({
			callWithTools,
			tools: tools ?? {
				search_mental_models: async () => ({
					mental_models: []
				}),
				search_observations: async () => ({
					observations: []
				}),
				recall: async () => ({
					memories: [
						{ id: 'mem-1', content: 'test memory' }
					]
				}),
				expand: async () => ({ memories: [] })
			},
			maxIterations: 5
		})
	}

	it("handles 'functions.done' prefix in tool call", async () => {
		const result = await createLoop([
			[
				{
					id: '1',
					name: 'recall',
					arguments: { query: 'test' }
				}
			],
			[
				{
					id: '2',
					name: 'functions.done',
					arguments: {
						answer: 'Test answer',
						memory_ids: ['mem-1']
					}
				}
			]
		])
		expect(result.text).toBe('Test answer')
		expect(result.usedMemoryIds).toContain('mem-1')
	})

	it("handles 'call=functions.done' prefix", async () => {
		const result = await createLoop([
			[
				{
					id: '1',
					name: 'recall',
					arguments: { query: 'test' }
				}
			],
			[
				{
					id: '2',
					name: 'call=functions.done',
					arguments: {
						answer: 'Test answer',
						memory_ids: ['mem-1']
					}
				}
			]
		])
		expect(result.text).toBe('Test answer')
	})

	it('recovers from unknown tool call', async () => {
		const result = await createLoop([
			[
				{
					id: '1',
					name: 'invalid_tool',
					arguments: { foo: 'bar' }
				}
			],
			[
				{
					id: '2',
					name: 'recall',
					arguments: { query: 'test' }
				}
			],
			[
				{
					id: '3',
					name: 'done',
					arguments: {
						answer: 'Recovered successfully',
						memory_ids: ['mem-1']
					}
				}
			]
		])
		expect(result.text).toBe('Recovered successfully')
		expect(result.iterations).toBe(3)
	})

	it('recovers from tool execution error', async () => {
		let calls = 0
		const tools = {
			search_mental_models: async () => ({
				mental_models: []
			}),
			search_observations: async () => ({
				observations: []
			}),
			recall: async () => {
				calls += 1
				if (calls === 1)
					throw new Error('Database connection failed')
				return {
					memories: [
						{ id: 'mem-1', content: 'test memory' }
					]
				}
			},
			expand: async () => ({ memories: [] })
		}

		const result = await createLoop(
			[
				[
					{
						id: '1',
						name: 'recall',
						arguments: { query: 'test' }
					}
				],
				[
					{
						id: '2',
						name: 'recall',
						arguments: { query: 'test retry' }
					}
				],
				[
					{
						id: '3',
						name: 'done',
						arguments: {
							answer: 'Recovered from error',
							memory_ids: ['mem-1']
						}
					}
				]
			],
			tools
		)
		expect(result.text).toBe('Recovered from error')
		expect(result.iterations).toBe(3)
	})

	it('normalizes tool names for all tools (search_mental_models, etc.)', async () => {
		let recallCalls = 0
		const tools = {
			search_mental_models: async () => ({
				mental_models: []
			}),
			search_observations: async () => ({
				observations: []
			}),
			recall: async () => {
				recallCalls += 1
				return {
					memories: [
						{ id: 'mem-1', content: 'test memory' }
					]
				}
			},
			expand: async () => ({ memories: [] })
		}
		const result = await createLoop(
			[
				[
					{
						id: '1',
						name: 'functions.recall',
						arguments: { query: 'test' }
					}
				],
				[
					{
						id: '2',
						name: 'done',
						arguments: {
							answer: 'Test answer',
							memory_ids: ['mem-1']
						}
					}
				]
			],
			tools
		)

		expect(result.text).toBe('Test answer')
		expect(recallCalls).toBe(1)
	})

	it('stops at max iterations', async () => {
		const calls: ToolCall[][] = [
			[{ id: '1', name: 'unknown_tool', arguments: {} }],
			[{ id: '2', name: 'unknown_tool', arguments: {} }],
			[{ id: '3', name: 'unknown_tool', arguments: {} }]
		]

		let index = 0
		const result = await _runReflectAgentLoopForTesting({
			callWithTools: async () => ({
				toolCalls:
					calls[Math.min(index++, calls.length - 1)] ?? [],
				finishReason: 'tool_calls'
			}),
			tools: {},
			maxIterations: 3
		})

		expect(result).toBeDefined()
		expect(result.iterations).toBe(3)
	})
})
