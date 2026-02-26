import { useEffect } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

/**
 * Hook to synchronize scroll position with collapsible animation
 * Ensures smooth scroll that matches the visual animation duration
 */
export function useCollapsibleScroll(
	ref: React.RefObject<HTMLElement>
) {
	const { scrollToBottom } = useStickToBottomContext()

	useEffect(() => {
		const element = ref.current
		if (!element) return

		// Handle animation events
		const handleAnimationEnd = () => {
			// When animation completes, ensure we're scrolled to bottom
			// Use requestAnimationFrame to let browser paint finish first
			requestAnimationFrame(() => {
				scrollToBottom({
					animation: 'smooth',
					duration: 200
				})
			})
		}

		element.addEventListener(
			'animationend',
			handleAnimationEnd
		)

		return () => {
			element.removeEventListener(
				'animationend',
				handleAnimationEnd
			)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- ref is a stable RefObject, ref.current shouldn't be a dep
	}, [scrollToBottom])
}
