import { useEffect, useRef, useState } from 'react'
import {
	AlertCircleIcon,
	Loader2Icon,
	Volume2Icon
} from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'
import { synthesizeSpeech } from '@/lib/tts-client'

export function SpeakButton({ text }: { text: string }) {
	const audioRef = useRef<HTMLAudioElement | null>(null)
	const [loading, setLoading] = useState(false)
	const [audioSrc, setAudioSrc] = useState<string | null>(
		null
	)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause()
			}
		}
	}, [])

	const handleSpeak = async () => {
		if (!text.trim()) return

		if (audioSrc && audioRef.current) {
			await audioRef.current.play()
			return
		}

		setLoading(true)
		setError(null)
		try {
			const result = await synthesizeSpeech(text)
			const src = result.audio.url
			const audio = new Audio(src)
			audioRef.current = audio
			setAudioSrc(src)
			await audio.play()
		} catch (err) {
			setError(
				err instanceof Error ? err.message : String(err)
			)
		} finally {
			setLoading(false)
		}
	}

	const tooltip = loading
		? 'Generating audio...'
		: error
			? error
			: audioSrc
				? 'Play voice'
				: 'Generate voice'

	return (
		<MessageAction
			tooltip={tooltip}
			onClick={() => void handleSpeak()}
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
