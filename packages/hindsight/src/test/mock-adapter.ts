/**
 * Configurable mock adapter for TanStack AI's AnyTextAdapter.
 *
 * Provides canned LLM responses for fact extraction, consolidation,
 * and reflect operations. Can be configured per-test to return specific
 * responses.
 *
 * Implements the full AG-UI streaming protocol that TanStack AI expects:
 * chatStream must yield: TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT → TEXT_MESSAGE_END → RUN_FINISHED
 */

export interface MockAdapterCall {
	messages: unknown[]
	options?: unknown
}

export interface MockAdapter {
	/** Configure the next response to return */
	setResponse(response: string): void
	/** Configure a queue of responses (returned in order) */
	setResponses(responses: string[]): void
	/** All calls made to the adapter */
	calls: MockAdapterCall[]
	/** Number of calls made */
	callCount: number
	/** Reset call history */
	reset(): void

	// Properties required by AnyTextAdapter
	readonly kind: 'text'
	readonly name: string
	readonly model: string
	chatStream: (options: unknown) => AsyncIterable<unknown>
	structuredOutput: (options: unknown) => Promise<unknown>
}

/** Default response for fact extraction — returns a simple fact */
const DEFAULT_EXTRACTION_RESPONSE = JSON.stringify({
	facts: [
		{
			content: 'Mock fact extracted from text',
			factType: 'experience',
			confidence: 0.9,
			occurredStart: null,
			occurredEnd: null,
			entities: [],
			tags: [],
			causalRelations: []
		}
	]
})

/**
 * Create a mock adapter that satisfies the TanStack AI AnyTextAdapter interface.
 *
 * The mock returns canned responses and tracks all calls for assertions.
 * Default behavior: returns a simple fact extraction JSON response.
 */
export function createMockAdapter(): MockAdapter {
	let nextResponse: string = DEFAULT_EXTRACTION_RESPONSE
	let responseQueue: string[] = []
	const calls: MockAdapterCall[] = []

	const adapter: MockAdapter = {
		// ── AnyTextAdapter required properties ──
		kind: 'text' as const,
		name: 'mock',
		model: 'mock-model',

		// ── Mock control API ──
		calls,
		get callCount() {
			return calls.length
		},

		setResponse(response: string) {
			nextResponse = response
			responseQueue = []
		},

		setResponses(responses: string[]) {
			responseQueue = [...responses]
		},

		reset() {
			calls.length = 0
			nextResponse = DEFAULT_EXTRACTION_RESPONSE
			responseQueue = []
		},

		// ── AnyTextAdapter.chatStream ──
		// Yields AG-UI protocol events for a text-only response.
		chatStream(options: unknown) {
			calls.push({ messages: [], options })
			const response =
				responseQueue.length > 0
					? responseQueue.shift()!
					: nextResponse

			return {
				async *[Symbol.asyncIterator]() {
					// TEXT_MESSAGE_START
					yield {
						type: 'TEXT_MESSAGE_START' as const,
						messageId: `msg-${Date.now()}`,
						timestamp: Date.now(),
						model: 'mock-model'
					}

					// TEXT_MESSAGE_CONTENT — emit the full response as one chunk
					yield {
						type: 'TEXT_MESSAGE_CONTENT' as const,
						messageId: `msg-${Date.now()}`,
						delta: response,
						timestamp: Date.now(),
						model: 'mock-model'
					}

					// TEXT_MESSAGE_END
					yield {
						type: 'TEXT_MESSAGE_END' as const,
						messageId: `msg-${Date.now()}`,
						timestamp: Date.now(),
						model: 'mock-model'
					}

					// RUN_FINISHED
					yield {
						type: 'RUN_FINISHED' as const,
						runId: `run-${Date.now()}`,
						timestamp: Date.now(),
						model: 'mock-model'
					}
				}
			}
		},

		// ── AnyTextAdapter.structuredOutput ──
		structuredOutput(_options: unknown) {
			calls.push({ messages: [], options: _options })
			const response =
				responseQueue.length > 0
					? responseQueue.shift()!
					: nextResponse

			return Promise.resolve({
				data: JSON.parse(response),
				rawResponse: response
			})
		}
	}

	return adapter
}
