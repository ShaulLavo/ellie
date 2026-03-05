/**
 * Types shared between features.ts and operations.ts.
 * Extracted to break a circular import dependency.
 */

/** A scored visual memory returned from recall fusion. */
export interface ScoredVisualMemory {
	id: string
	bankId: string
	sourceId: string | null
	description: string
	score: number
	createdAt: number
}

/** Result from reflect() */
export interface ReflectResult {
	answer: string
	memories: import('../schemas').ScoredMemory[]
	observations: string[]
	structuredOutput?: Record<string, unknown> | null
	trace?: {
		startedAt: number
		durationMs: number
		toolCalls: Array<{
			tool: string
			durationMs: number
			input: Record<string, unknown>
			outputSize: number
			error?: string
		}>
	}
}
