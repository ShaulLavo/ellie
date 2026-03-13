import {
	AlertCircleIcon,
	Loader2Icon,
	Volume2Icon
} from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'
import { useSpeak } from '../hooks/use-speak'

export function SpeakButton({ text }: { text: string }) {
	const { loading, error, tooltip, speak } = useSpeak(text)

	return (
		<MessageAction
			tooltip={tooltip}
			onClick={() => void speak()}
			disabled={loading || !text.trim()}
		>
			{loading ? (
				<Loader2Icon className="size-3.5 animate-spin" />
			) : error ? (
				<AlertCircleIcon className="size-3.5" />
			) : (
				<Volume2Icon className="size-3.5" />
			)}
		</MessageAction>
	)
}
