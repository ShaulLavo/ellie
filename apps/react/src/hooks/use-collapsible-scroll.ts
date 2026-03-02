import { useEffect } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

/**
 * Prevents StickToBottom from auto-scrolling when a collapsible
 * expands/collapses. Calls stopScroll() on animation start so the
 * resize observer doesn't yank the user to the bottom.
 */
export function useCollapsibleScroll(
	ref: React.RefObject<HTMLElement | null>
) {
	const { stopScroll } = useStickToBottomContext()

	useEffect(() => {
		const element = ref.current
		if (!element) return

		const handleAnimationStart = () => {
			stopScroll()
		}

		element.addEventListener(
			'animationstart',
			handleAnimationStart
		)

		return () => {
			element.removeEventListener(
				'animationstart',
				handleAnimationStart
			)
		}
	}, [stopScroll, ref])
}
