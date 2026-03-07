import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockHeader,
	CodeBlockTitle
} from '@/components/ai-elements/code-block'
import type { ColumnInfo } from '../types'

interface CellDetailDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	column: ColumnInfo | null
	value: unknown
}

function getRawText(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'object')
		return JSON.stringify(value, null, 2)
	return String(value)
}

/** Try to format value as pretty-printed JSON. Works for objects and JSON strings. */
function tryFormatJson(value: unknown): string | null {
	if (typeof value === 'object' && value !== null) {
		return JSON.stringify(value, null, 2)
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (
			(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
			(trimmed.startsWith('[') && trimmed.endsWith(']'))
		) {
			try {
				const parsed = JSON.parse(trimmed)
				return JSON.stringify(parsed, null, 2)
			} catch {
				return null
			}
		}
	}
	return null
}

export function CellDetailDialog({
	open,
	onOpenChange,
	column,
	value
}: CellDetailDialogProps) {
	const { isCopied, copy } = useCopyToClipboard(() =>
		getRawText(value)
	)

	const formattedJson = tryFormatJson(value)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col gap-3">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-base">
						<span className="font-mono">
							{column?.name}
						</span>
						{column?.type && (
							<Badge
								variant="outline"
								className="text-[10px] px-1.5 py-0 h-4 font-mono uppercase tracking-wider text-muted-foreground"
							>
								{column.type}
							</Badge>
						)}
					</DialogTitle>
				</DialogHeader>

				<div className="flex-1 min-h-0">
					{formattedJson ? (
						<CodeBlock
							code={formattedJson}
							language="json"
							small
						>
							<CodeBlockHeader>
								<CodeBlockTitle>
									<span className="font-mono text-muted-foreground">
										json
									</span>
								</CodeBlockTitle>
								<CodeBlockActions>
									<CodeBlockCopyButton />
								</CodeBlockActions>
							</CodeBlockHeader>
						</CodeBlock>
					) : (
						<div className="overflow-auto h-full rounded-md border bg-muted/30 p-4">
							<PlainContent value={value} />
						</div>
					)}
				</div>

				{!formattedJson && (
					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							onClick={copy}
							className="gap-1.5"
						>
							{isCopied ? (
								<Check className="size-3.5" />
							) : (
								<Copy className="size-3.5" />
							)}
							{isCopied ? 'Copied' : 'Copy value'}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	)
}

function PlainContent({ value }: { value: unknown }) {
	if (value === null || value === undefined) {
		return (
			<span className="text-muted-foreground/60 italic text-sm font-mono">
				NULL
			</span>
		)
	}

	return (
		<div className="text-sm font-mono whitespace-pre-wrap break-words text-foreground leading-relaxed">
			{String(value)}
		</div>
	)
}
