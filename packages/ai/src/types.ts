export type ProviderName = 'anthropic' | 'openai' | 'ollama' | 'openrouter'

export type ModelInputType = 'text' | 'image'

/** Cost per million tokens */
export interface ModelCost {
	/** $/million input tokens */
	input: number
	/** $/million output tokens */
	output: number
	/** $/million cache-read tokens (0 if not supported) */
	cacheRead: number
	/** $/million cache-write tokens (0 if not supported) */
	cacheWrite: number
}

export interface Model {
	id: string
	name: string
	provider: ProviderName
	reasoning: boolean
	input: ModelInputType[]
	cost: ModelCost
	contextWindow: number
	maxTokens: number
}

/** Calculated cost breakdown in dollars */
export interface CostBreakdown {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	total: number
}

/** Extended usage with token counts and cost */
export interface Usage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	cost: CostBreakdown
}

/** Unified thinking effort levels across providers */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
