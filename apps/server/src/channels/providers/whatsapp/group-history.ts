/**
 * In-memory group history buffer for unmentioned messages.
 * Matching OpenCLAW's groupHistories pattern — volatile (lost on restart).
 *
 * When a group message doesn't trigger the bot (no mention), it's stored
 * in the buffer. When the bot IS triggered, the buffer is consumed and
 * prepended to the message text as conversation context.
 */

export type GroupHistoryEntry = {
	sender: string
	body: string
	timestamp?: number
}

const MAX_GROUP_HISTORY_KEYS = 200

/**
 * Record a group message in the history buffer.
 * Evicts oldest entries if over limit; evicts oldest group key if too many tracked.
 */
export function recordGroupHistory(
	histories: Map<string, GroupHistoryEntry[]>,
	groupJid: string,
	entry: GroupHistoryEntry,
	limit: number
): void {
	const history = histories.get(groupJid) ?? []
	history.push(entry)
	while (history.length > limit) history.shift()
	histories.set(groupJid, history)

	// LRU eviction: remove oldest group if too many tracked
	if (histories.size > MAX_GROUP_HISTORY_KEYS) {
		const oldest = histories.keys().next().value
		if (oldest && oldest !== groupJid) {
			histories.delete(oldest)
		}
	}
}

/**
 * Consume the history buffer for a group, prepending it to the current message.
 * Clears the buffer after consuming.
 */
export function buildContextText(
	histories: Map<string, GroupHistoryEntry[]>,
	groupJid: string,
	currentText: string
): string {
	const history = histories.get(groupJid)
	if (!history?.length) return currentText

	const historyText = history
		.map(e => `${e.sender}: ${e.body}`)
		.join('\n')

	// Clear buffer after consuming
	histories.set(groupJid, [])

	return [
		'[Chat messages since your last reply - for context]',
		historyText,
		'',
		'[Current message]',
		currentText
	].join('\n')
}
