import type { Model, Usage, CostBreakdown } from './types'

/**
 * Calculate the cost breakdown for a given model and token counts.
 * Costs are computed from the model's $/million-token pricing.
 */
export function calculateCost(
	model: Model,
	tokens: {
		input: number
		output: number
		cacheRead?: number
		cacheWrite?: number
	}
): CostBreakdown {
	const { cost } = model
	const inputCost = (tokens.input * cost.input) / 1_000_000
	const outputCost =
		(tokens.output * cost.output) / 1_000_000
	const cacheReadCost =
		((tokens.cacheRead ?? 0) * cost.cacheRead) / 1_000_000
	const cacheWriteCost =
		((tokens.cacheWrite ?? 0) * cost.cacheWrite) / 1_000_000

	return {
		input: inputCost,
		output: outputCost,
		cacheRead: cacheReadCost,
		cacheWrite: cacheWriteCost,
		total:
			inputCost +
			outputCost +
			cacheReadCost +
			cacheWriteCost
	}
}

/**
 * Create a full Usage object from raw token counts and a model.
 */
export function createUsage(
	model: Model,
	tokens: {
		input: number
		output: number
		cacheRead?: number
		cacheWrite?: number
	}
): Usage {
	const cost = calculateCost(model, tokens)
	return {
		input: tokens.input,
		output: tokens.output,
		cacheRead: tokens.cacheRead ?? 0,
		cacheWrite: tokens.cacheWrite ?? 0,
		totalTokens: tokens.input + tokens.output,
		cost
	}
}

/**
 * Map TanStack AI's usage format to our Usage type.
 * TanStack AI reports: { promptTokens, completionTokens, totalTokens }
 * Cache tokens default to 0 since TanStack AI doesn't expose them.
 */
export function mapTanStackUsage(
	model: Model,
	tanstackUsage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
	}
): Usage {
	return createUsage(model, {
		input: tanstackUsage.promptTokens,
		output: tanstackUsage.completionTokens
	})
}
