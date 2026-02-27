export interface SessionStats {
	model: string | null
	provider: string | null
	messageCount: number
	promptTokens: number
	completionTokens: number
	totalCost: number
}

export const EMPTY_STATS: SessionStats = {
	model: null,
	provider: null,
	messageCount: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalCost: 0
}

interface StatsRow {
	type: string
	payload: string | Record<string, unknown>
}

function safeParsePayload(
	row: StatsRow
): Record<string, unknown> | null {
	try {
		return typeof row.payload === 'string'
			? (JSON.parse(row.payload) as Record<string, unknown>)
			: (row.payload as Record<string, unknown>)
	} catch {
		return null
	}
}

export function computeStatsFromEvents(
	events: StatsRow[]
): SessionStats {
	let model: string | null = null
	let provider: string | null = null
	let promptTokens = 0
	let completionTokens = 0
	let totalCost = 0
	let messageCount = 0

	for (const row of events) {
		if (
			row.type === 'user_message' ||
			row.type === 'assistant_final'
		) {
			messageCount++
		}

		if (row.type !== 'assistant_final') continue

		const parsed = safeParsePayload(row)
		if (!parsed) continue

		if (typeof parsed.model === 'string')
			model = parsed.model
		if (typeof parsed.provider === 'string')
			provider = parsed.provider

		const usage = parsed.usage as
			| {
					input?: number
					output?: number
					cost?: { total?: number }
			  }
			| undefined
		if (usage) {
			promptTokens += usage.input ?? 0
			completionTokens += usage.output ?? 0
			totalCost += usage.cost?.total ?? 0
		}
	}

	return {
		model,
		provider,
		messageCount,
		promptTokens,
		completionTokens,
		totalCost
	}
}

interface MessageLike {
	role: string
	model?: unknown
	provider?: unknown
	usage?: unknown
}

export function computeStatsFromMessages(
	messages: MessageLike[]
): SessionStats {
	let model: string | null = null
	let provider: string | null = null
	let promptTokens = 0
	let completionTokens = 0
	let totalCost = 0
	let messageCount = 0

	for (const msg of messages) {
		if (msg.role === 'toolResult') continue
		messageCount++
		if (msg.role !== 'assistant') continue

		if (typeof msg.model === 'string') model = msg.model
		if (typeof msg.provider === 'string')
			provider = msg.provider

		const usage = msg.usage as
			| {
					input?: number
					output?: number
					cost?: { total?: number }
			  }
			| undefined
		if (usage) {
			promptTokens += usage.input ?? 0
			completionTokens += usage.output ?? 0
			totalCost += usage.cost?.total ?? 0
		}
	}

	return {
		model,
		provider,
		messageCount,
		promptTokens,
		completionTokens,
		totalCost
	}
}
