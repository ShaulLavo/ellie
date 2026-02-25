const CHAT_MESSAGE_ID_SELECTOR = '[data-chat-message-id]'

interface ResolveSelectedMarkdownOptions {
	container: HTMLElement | null
	messageOrder: string[]
	markdownById: Map<string, string>
	selection?: Selection | null
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
	if (typeof range.intersectsNode === 'function') {
		return range.intersectsNode(node)
	}

	const ownerDocument =
		node.ownerDocument ?? (node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : null)
	if (!ownerDocument) return false

	const nodeRange = ownerDocument.createRange()
	nodeRange.selectNodeContents(node)

	const startsBeforeNodeEnds = range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0
	const endsAfterNodeStarts = range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0

	return startsBeforeNodeEnds && endsAfterNodeStarts
}

function getSelectionRanges(selection: Selection): Range[] {
	const ranges: Range[] = []
	for (let i = 0; i < selection.rangeCount; i++) {
		ranges.push(selection.getRangeAt(i))
	}
	return ranges
}

function getSelectedMessageIds(container: HTMLElement, selection: Selection): string[] {
	if (selection.isCollapsed) return []

	const ranges = getSelectionRanges(selection)
	if (ranges.length === 0) return []

	const intersectsContainer = ranges.some((range) => rangeIntersectsNode(range, container))
	if (!intersectsContainer) return []

	const selected = new Set<string>()
	const messageNodes = container.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ID_SELECTOR)

	for (const node of messageNodes) {
		const messageId = node.dataset.chatMessageId
		if (!messageId) continue

		const intersectsAnyRange = ranges.some((range) => rangeIntersectsNode(range, node))
		if (!intersectsAnyRange) continue

		selected.add(messageId)
	}

	return [...selected]
}

export function resolveSelectedMarkdown({
	container,
	messageOrder,
	markdownById,
	selection = typeof window !== 'undefined' ? window.getSelection() : null
}: ResolveSelectedMarkdownOptions): string | null {
	if (!container || !selection) return null

	const selectedIds = getSelectedMessageIds(container, selection)
	if (selectedIds.length === 0) return null

	const selectedSet = new Set(selectedIds)
	const orderedMarkdown = messageOrder
		.filter((id) => selectedSet.has(id))
		.map((id) => markdownById.get(id)?.trim())
		.filter((value): value is string => typeof value === 'string' && value.length > 0)

	if (orderedMarkdown.length === 0) return null
	return orderedMarkdown.join('\n\n').replace(/\n{3,}/g, '\n\n')
}

export function setMarkdownClipboardData(clipboardData: DataTransfer, markdown: string) {
	clipboardData.setData('text/plain', markdownToPlainText(markdown))
	clipboardData.setData('text/markdown', markdown)
}

function markdownToPlainText(markdown: string): string {
	return markdown.replace(/\n{2,}/g, '\n')
}

export async function writeMarkdownToSystemClipboard(markdown: string) {
	if (typeof navigator === 'undefined' || !navigator.clipboard) return

	const plainText = markdownToPlainText(markdown)

	if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
		const textPlain = new Blob([plainText], { type: 'text/plain' })
		const textMarkdown = new Blob([markdown], { type: 'text/markdown' })
		const item = new ClipboardItem({
			'text/plain': textPlain,
			'text/markdown': textMarkdown
		})

		await navigator.clipboard.write([item])
		return
	}

	if (!navigator.clipboard.writeText) return
	await navigator.clipboard.writeText(plainText)
}
