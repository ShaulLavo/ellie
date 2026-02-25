import { animate } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

/**
 * Smoothly reveals streaming text by animating a cursor through accumulated content.
 * During streaming, text appears word-by-word with easing.
 * Once streaming stops, the full text is shown immediately.
 */
export function useAnimatedText(
	text: string,
	isStreaming: boolean,
	delimiter = ' '
) {
	const [cursor, setCursor] = useState(0)
	const [startingCursor, setStartingCursor] = useState(0)
	const prevTextRef = useRef(text)

	useEffect(() => {
		const prevText = prevTextRef.current
		if (prevText !== text) {
			prevTextRef.current = text
			setStartingCursor(
				text.startsWith(prevText) ? cursor : 0
			) // eslint-disable-line react-hooks/set-state-in-effect -- intentional: sync cursor reset on text change
		}
	}, [text, cursor])

	useEffect(() => {
		if (!isStreaming) {
			// When streaming ends, jump to the end immediately
			const parts = text.split(delimiter)
			setCursor(parts.length) // eslint-disable-line react-hooks/set-state-in-effect -- intentional: immediate jump when streaming stops
			return
		}

		const parts = text.split(delimiter)
		const controls = animate(startingCursor, parts.length, {
			duration: 0.6,
			ease: 'easeOut',
			onUpdate(latest) {
				setCursor(Math.floor(latest))
			}
		})

		return () => controls.stop()
	}, [startingCursor, text, delimiter, isStreaming])

	if (!isStreaming) return text

	return text
		.split(delimiter)
		.slice(0, cursor)
		.join(delimiter)
}
