import { useEffect, useRef, useState } from 'react'
import { CopyIcon, CheckIcon } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'

export function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false)
	const timerRef = useRef<ReturnType<
		typeof setTimeout
	> | null>(null)

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current)
		},
		[]
	)

	const handleCopy = async () => {
		await navigator.clipboard.writeText(text)
		setCopied(true)
		if (timerRef.current) clearTimeout(timerRef.current)
		timerRef.current = setTimeout(
			() => setCopied(false),
			2000
		)
	}

	return (
		<MessageAction
			tooltip={copied ? 'Copied!' : 'Copy'}
			onClick={handleCopy}
		>
			{copied ? (
				<CheckIcon className="size-3.5" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
		</MessageAction>
	)
}
