import { CopyIcon, CheckIcon } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

export function CopyButton({ text }: { text: string }) {
	const { isCopied, copy } = useCopyToClipboard(text)

	return (
		<MessageAction
			tooltip={isCopied ? 'Copied!' : 'Copy'}
			onClick={copy}
			className="size-6"
		>
			{isCopied ? (
				<CheckIcon className="size-3.5" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
		</MessageAction>
	)
}
