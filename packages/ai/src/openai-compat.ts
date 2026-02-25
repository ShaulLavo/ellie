/**
 * OpenAI-compatible text adapter for TanStack AI.
 *
 * Uses raw fetch() with SSE streaming — no openai SDK dependency.
 * Follows the same AG-UI event protocol as the Anthropic and Ollama adapters.
 *
 * Factory function: `groqChat(model, apiKey)` for Groq-hosted models.
 */

import {
	BaseTextAdapter,
	type StructuredOutputOptions,
	type StructuredOutputResult
} from '@tanstack/ai/adapters'
import type { DefaultMessageMetadataByModality, StreamChunk, TextOptions } from '@tanstack/ai'

// ── Config ──────────────────────────────────────────────────────────────────

export interface OpenAICompatConfig {
	baseUrl: string
	apiKey: string
	providerName?: string
	timeout?: number
	defaultHeaders?: Record<string, string>
}

// ── OpenAI API types ────────────────────────────────────────────────────────

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | null
	name?: string
	tool_calls?: Array<{
		id: string
		type: 'function'
		function: { name: string; arguments: string }
	}>
	tool_call_id?: string
}

interface OpenAITool {
	type: 'function'
	function: {
		name: string
		description?: string
		parameters?: Record<string, unknown>
	}
}

interface OpenAIDelta {
	role?: string
	content?: string | null
	tool_calls?: Array<{
		index: number
		id?: string
		type?: 'function'
		function?: { name?: string; arguments?: string }
	}>
}

interface OpenAIStreamChoice {
	index: number
	delta: OpenAIDelta
	finish_reason: string | null
}

interface OpenAIStreamChunk {
	id: string
	object: string
	choices: OpenAIStreamChoice[]
}

interface OpenAIChoice {
	index: number
	message: {
		role: string
		content: string | null
		tool_calls?: Array<{
			id: string
			type: 'function'
			function: { name: string; arguments: string }
		}>
	}
	finish_reason: string
}

interface OpenAIResponse {
	id: string
	choices: OpenAIChoice[]
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class OpenAICompatTextAdapter<TModel extends string> extends BaseTextAdapter<
	TModel,
	Record<string, unknown>,
	readonly ['text'],
	DefaultMessageMetadataByModality
> {
	readonly name: string
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly timeout: number
	private readonly defaultHeaders: Record<string, string>

	constructor(compat: OpenAICompatConfig, model: TModel) {
		super({ apiKey: compat.apiKey, baseUrl: compat.baseUrl, timeout: compat.timeout }, model)
		this.name = compat.providerName ?? 'openai-compat'
		this.baseUrl = compat.baseUrl.replace(/\/$/, '')
		this.apiKey = compat.apiKey
		this.timeout = compat.timeout ?? 120_000
		this.defaultHeaders = compat.defaultHeaders ?? {}
	}

	// ── chatStream ──────────────────────────────────────────────────────────

	async *chatStream(options: TextOptions<Record<string, unknown>>): AsyncIterable<StreamChunk> {
		const runId = this.generateId()
		const messageId = this.generateId()

		yield { type: 'RUN_STARTED', threadId: runId, runId } as StreamChunk

		const messages = this.formatMessages(options)
		const tools = this.convertTools(options)

		const body: Record<string, unknown> = {
			model: this.model,
			messages,
			stream: true,
			...this.mapCommonOptions(options)
		}
		if (tools.length > 0) {
			body.tools = tools
			body.tool_choice = 'auto'
		}

		const jsonBody = JSON.stringify(body)

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
				...this.defaultHeaders
			},
			body: jsonBody,
			signal: AbortSignal.timeout(this.timeout)
		})

		if (!response.ok) {
			const errorText = await response.text()
			yield {
				type: 'RUN_ERROR',
				error: {
					message: `${this.name} API error (HTTP ${response.status}): ${errorText.slice(0, 500)}`,
					code: String(response.status)
				}
			} as StreamChunk
			return
		}

		yield { type: 'TEXT_MESSAGE_START', messageId } as StreamChunk

		// Track tool calls being built up across SSE chunks
		const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>()
		let lastFinishReason: string | null = null

		const reader = response.body!.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith(':')) continue
					if (trimmed === 'data: [DONE]') continue
					if (!trimmed.startsWith('data: ')) continue

					const jsonStr = trimmed.slice(6)
					let chunk: OpenAIStreamChunk
					try {
						chunk = JSON.parse(jsonStr)
					} catch {
						continue
					}

					if (!chunk.choices) continue
					for (const choice of chunk.choices) {
						const delta = choice.delta

						// Text content
						if (delta.content) {
							yield {
								type: 'TEXT_MESSAGE_CONTENT',
								messageId,
								delta: delta.content
							} as StreamChunk
						}

						// Tool calls
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								if (tc.id) {
									// New tool call starting
									const initialArgs = tc.function?.arguments ?? ''
									pendingToolCalls.set(tc.index, {
										id: tc.id,
										name: tc.function?.name ?? '',
										args: initialArgs
									})
									yield {
										type: 'TOOL_CALL_START',
										toolCallId: tc.id,
										toolName: tc.function?.name ?? ''
									} as StreamChunk
									// Some providers (e.g. Groq) include arguments in the first
									// chunk alongside the tool call ID. Emit them immediately so
									// TanStack AI's ToolCallManager accumulates them.
									if (initialArgs) {
										yield {
											type: 'TOOL_CALL_ARGS',
											toolCallId: tc.id,
											delta: initialArgs
										} as StreamChunk
									}
								} else {
									// Continuing existing tool call
									const pending = pendingToolCalls.get(tc.index)
									if (pending && tc.function?.arguments) {
										pending.args += tc.function.arguments
										yield {
											type: 'TOOL_CALL_ARGS',
											toolCallId: pending.id,
											delta: tc.function.arguments
										} as StreamChunk
									}
								}
							}
						}

						// Track finish reason for RUN_FINISHED event
						if (choice.finish_reason) {
							lastFinishReason = choice.finish_reason
						}

						// Finish reason — end any pending tool calls
						if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
							for (const [, pending] of pendingToolCalls) {
								yield {
									type: 'TOOL_CALL_END',
									toolCallId: pending.id
								} as StreamChunk
							}
							pendingToolCalls.clear()
						}
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		yield { type: 'TEXT_MESSAGE_END', messageId } as StreamChunk

		// Map OpenAI finish_reason to AG-UI finishReason.
		// TanStack AI uses finishReason === "tool_calls" to decide whether to
		// execute tools and continue the agentic loop.
		const finishReason =
			lastFinishReason === 'tool_calls'
				? 'tool_calls'
				: lastFinishReason === 'length'
					? 'length'
					: 'stop'

		yield {
			type: 'RUN_FINISHED',
			threadId: runId,
			runId,
			finishReason,
			timestamp: Date.now()
		} as StreamChunk
	}

	// ── structuredOutput ────────────────────────────────────────────────────

	async structuredOutput(
		options: StructuredOutputOptions<Record<string, unknown>>
	): Promise<StructuredOutputResult<unknown>> {
		const messages = this.formatMessages(options.chatOptions)

		// Add schema instruction to system prompt
		const schemaInstruction = `\n\nYou must respond with valid JSON matching this schema:\n${JSON.stringify(options.outputSchema, null, 2)}\n\nRespond ONLY with the JSON object, no extra text.`

		if (messages.length > 0 && messages[0].role === 'system') {
			messages[0].content = (messages[0].content ?? '') + schemaInstruction
		} else {
			messages.unshift({ role: 'system', content: schemaInstruction })
		}

		const body: Record<string, unknown> = {
			model: this.model,
			messages,
			stream: false,
			response_format: { type: 'json_object' },
			...this.mapCommonOptions(options.chatOptions)
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
				...this.defaultHeaders
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeout)
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`${this.name} API error ${response.status}: ${errorText}`)
		}

		const result: OpenAIResponse = await response.json()
		const rawText = result.choices[0]?.message?.content ?? ''

		try {
			const data = JSON.parse(rawText)
			return { data, rawText }
		} catch {
			throw new Error(`Failed to parse JSON from ${this.name}: ${rawText.slice(0, 200)}`)
		}
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	private formatMessages(options: TextOptions<Record<string, unknown>>): OpenAIMessage[] {
		const result: OpenAIMessage[] = []

		// System prompts (TanStack AI passes an array via systemPrompts)
		if (options.systemPrompts && options.systemPrompts.length > 0) {
			result.push({ role: 'system', content: options.systemPrompts.join('\n\n') })
		}

		// Messages
		if (options.messages) {
			for (const msg of options.messages) {
				const m = msg as unknown as Record<string, unknown>
				const role = m.role as string
				if (role === 'user') {
					result.push({ role: 'user', content: this.extractTextContent(m) })
				} else if (role === 'assistant') {
					// TanStack AI stores tool calls in `toolCalls` field (array of ToolCall objects)
					const tcArray = m.toolCalls as Array<Record<string, unknown>> | undefined
					if (tcArray && tcArray.length > 0) {
						result.push({
							role: 'assistant',
							content: (m.content as string | null) ?? null,
							tool_calls: tcArray.map(tc => {
								const fn = tc.function as Record<string, unknown> | undefined
								return {
									id: (tc.id as string) ?? '',
									type: 'function' as const,
									function: {
										name: (fn?.name as string) ?? '',
										arguments:
											typeof fn?.arguments === 'string'
												? fn.arguments
												: JSON.stringify(fn?.arguments ?? {})
									}
								}
							})
						})
					} else {
						// Check for tool calls in parts (UIMessage format)
						const parts = m.parts as Array<Record<string, unknown>> | undefined
						const toolCallParts = parts?.filter(p => p.type === 'tool-call')
						if (toolCallParts && toolCallParts.length > 0) {
							result.push({
								role: 'assistant',
								content: null,
								tool_calls: toolCallParts.map(tc => ({
									id: tc.toolCallId as string,
									type: 'function' as const,
									function: {
										name: tc.toolName as string,
										arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
									}
								}))
							})
						} else {
							result.push({ role: 'assistant', content: this.extractTextContent(m) })
						}
					}
				} else if (role === 'tool') {
					result.push({
						role: 'tool',
						content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
						tool_call_id: m.toolCallId as string
					})
				}
			}
		}

		return result
	}

	private extractTextContent(msg: Record<string, unknown>): string {
		if (typeof msg.content === 'string') return msg.content
		if (Array.isArray(msg.content)) {
			return (msg.content as Array<Record<string, unknown>>)
				.filter(p => p.type === 'text')
				.map(p => p.text as string)
				.join('')
		}
		// UIMessage format uses `parts` instead of `content`
		if (Array.isArray(msg.parts)) {
			return (msg.parts as Array<Record<string, unknown>>)
				.filter(p => p.type === 'text')
				.map(p => p.text as string)
				.join('')
		}
		return ''
	}

	private convertTools(options: TextOptions<Record<string, unknown>>): OpenAITool[] {
		if (!options.tools) return []
		// TanStack AI passes tools as an array of Tool objects with { name, description, inputSchema }
		const tools = Array.isArray(options.tools) ? options.tools : Object.values(options.tools)
		return tools.map((t: unknown) => {
			const tool = t as Record<string, unknown>
			return {
				type: 'function' as const,
				function: {
					name: (tool.name as string) ?? 'unknown',
					description: tool.description as string | undefined,
					parameters: (tool.inputSchema ?? tool.parameters) as Record<string, unknown> | undefined
				}
			}
		})
	}

	private mapCommonOptions(options: TextOptions<Record<string, unknown>>): Record<string, unknown> {
		const mapped: Record<string, unknown> = {}
		if (options.temperature !== undefined) mapped.temperature = options.temperature
		if (options.topP !== undefined) mapped.top_p = options.topP
		if (options.maxTokens !== undefined) mapped.max_tokens = options.maxTokens
		// Pass through provider-specific options (e.g. response_format for JSON mode)
		if (options.modelOptions && typeof options.modelOptions === 'object') {
			for (const [key, value] of Object.entries(options.modelOptions)) {
				mapped[key] = value
			}
		}
		return mapped
	}
}

// ── Factory functions ───────────────────────────────────────────────────────

export function createOpenAICompatChat<TModel extends string>(
	model: TModel,
	config: OpenAICompatConfig
): OpenAICompatTextAdapter<TModel> {
	return new OpenAICompatTextAdapter(config, model)
}

/**
 * Create a Groq-hosted chat adapter.
 *
 * Uses Groq's OpenAI-compatible API at https://api.groq.com/openai/v1.
 */
export function groqChat<TModel extends string>(
	model: TModel,
	apiKey: string
): OpenAICompatTextAdapter<TModel> {
	return new OpenAICompatTextAdapter(
		{
			baseUrl: 'https://api.groq.com/openai/v1',
			apiKey,
			providerName: 'groq'
		},
		model
	)
}
