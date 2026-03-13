export interface SessionStats {
	model: string | null
	provider: string | null
	messageCount: number
	promptTokens: number
	completionTokens: number
	totalCost: number
	lastPromptTokens: number
}

export const EMPTY_STATS: SessionStats = {
	model: null,
	provider: null,
	messageCount: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalCost: 0,
	lastPromptTokens: 0
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
	let lastPromptTokens = 0

	for (const row of events) {
		if (row.type === 'user_message') {
			messageCount++
			continue
		}

		// Count completed assistant_message events
		if (row.type === 'assistant_message') {
			const parsed = safeParsePayload(row)
			if (!parsed) continue
			if (parsed.streaming === true) continue // skip in-flight
			messageCount++
			const msg = parsed.message as
				| Record<string, unknown>
				| undefined
			if (!msg) continue
			if (typeof msg.model === 'string')
				model = msg.model as string
			if (typeof msg.provider === 'string')
				provider = msg.provider as string
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
				lastPromptTokens = usage.input ?? 0
			}
			continue
		}
	}

	return {
		model,
		provider,
		messageCount,
		promptTokens,
		completionTokens,
		totalCost,
		lastPromptTokens
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
	let lastPromptTokens = 0

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
			lastPromptTokens = usage.input ?? 0
		}
	}

	return {
		model,
		provider,
		messageCount,
		promptTokens,
		completionTokens,
		totalCost,
		lastPromptTokens
	}
}
