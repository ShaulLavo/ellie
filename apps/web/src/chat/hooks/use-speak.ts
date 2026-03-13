import { useEffect, useRef, useState } from 'react'
import { synthesizeSpeech } from '@/lib/tts-client'

export function useSpeak(text: string) {
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

	const speak = async () => {
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
		}
		setLoading(false)
	}

	const tooltip = loading
		? 'Generating audio...'
		: error
			? error
			: audioSrc
				? 'Play voice'
				: 'Generate voice'

	return { loading, error, tooltip, speak }
}
