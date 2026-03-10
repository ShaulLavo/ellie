/** Maximum WhatsApp message length before chunking. */
const MAX_MESSAGE_LENGTH = 4000

/**
 * Convert common markdown formatting to WhatsApp-style formatting.
 *
 * Conversions:
 * - **bold** / __bold__ → *bold*
 * - *italic* / _italic_ → _italic_   (already correct for single-underscore)
 * - ~~strikethrough~~ → ~strikethrough~
 * - `inline code` → `inline code`    (already correct)
 * - ```code blocks``` → ```code blocks```  (already correct)
 * - [text](url) → text (url)
 * - # headers → *headers*
 */
export function markdownToWhatsApp(text: string): string {
	let result = text

	// Preserve code blocks first (don't transform inside them)
	const codeBlocks: string[] = []
	result = result.replace(/```[\s\S]*?```/g, match => {
		codeBlocks.push(match)
		return `\x00CB${codeBlocks.length - 1}\x00`
	})

	// Preserve inline code
	const inlineCode: string[] = []
	result = result.replace(/`[^`]+`/g, match => {
		inlineCode.push(match)
		return `\x00IC${inlineCode.length - 1}\x00`
	})

	// **bold** or __bold__ → *bold*
	result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')
	result = result.replace(/__(.+?)__/g, '*$1*')

	// ~~strikethrough~~ → ~strikethrough~
	result = result.replace(/~~(.+?)~~/g, '~$1~')

	// [text](url) → text (url)
	result = result.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'$1 ($2)'
	)

	// # headers → *bold headers*
	result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

	// Restore inline code
	result = result.replace(
		/\x00IC(\d+)\x00/g,
		(_, idx) => inlineCode[Number(idx)]
	)

	// Restore code blocks
	result = result.replace(
		/\x00CB(\d+)\x00/g,
		(_, idx) => codeBlocks[Number(idx)]
	)

	return result
}

/**
 * Split a message into chunks, each ≤ maxLen characters.
 * Tries newline break first, then whitespace (word boundary), then hard-breaks.
 * Guarantees every chunk ≤ maxLen (matching openclaw's chunkText).
 */
export function chunkMessage(
	text: string,
	maxLen: number = MAX_MESSAGE_LENGTH
): string[] {
	if (text.length <= maxLen) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > maxLen) {
		const window = remaining.slice(0, maxLen)

		// Try to break at the last newline within the window
		const newlineIdx = window.lastIndexOf('\n')
		if (newlineIdx > 0) {
			chunks.push(remaining.slice(0, newlineIdx))
			remaining = remaining.slice(newlineIdx + 1)
			continue
		}

		// Try to break at the last whitespace within the window
		const spaceIdx = window.lastIndexOf(' ')
		if (spaceIdx > 0) {
			chunks.push(remaining.slice(0, spaceIdx))
			remaining = remaining.slice(spaceIdx + 1)
			continue
		}

		// Hard-break at exactly maxLen
		chunks.push(remaining.slice(0, maxLen))
		remaining = remaining.slice(maxLen)
	}

	if (remaining) chunks.push(remaining)

	return chunks
}
