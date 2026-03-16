import { useEffect, useRef, useState } from 'react'

type ScrollAxis = 'horizontal' | 'vertical' | 'both'

interface Fades {
	left: boolean
	right: boolean
	top: boolean
	bottom: boolean
}

const INITIAL_FADES: Fades = {
	left: false,
	right: false,
	top: false,
	bottom: false
}

export function useScrollFade(axis: ScrollAxis) {
	const containerRef = useRef<HTMLDivElement | null>(null)
	const contentRef = useRef<HTMLDivElement | null>(null)
	const [fades, setFades] = useState<Fades>(INITIAL_FADES)

	useEffect(() => {
		const container = containerRef.current
		if (!container) return

		const checkScroll = () => {
			const {
				scrollLeft,
				scrollTop,
				scrollWidth,
				scrollHeight,
				clientWidth,
				clientHeight
			} = container

			setFades(prev => {
				const next: Fades = {
					left: false,
					right: false,
					top: false,
					bottom: false
				}

				if (axis === 'horizontal' || axis === 'both') {
					next.left = scrollLeft > 0
					next.right =
						Math.ceil(scrollLeft + clientWidth) <
						Math.floor(scrollWidth - 1)
				}

				if (axis === 'vertical' || axis === 'both') {
					next.top = scrollTop > 0
					next.bottom =
						Math.ceil(scrollTop + clientHeight) <
						Math.floor(scrollHeight - 1)
				}

				if (
					prev.left === next.left &&
					prev.right === next.right &&
					prev.top === next.top &&
					prev.bottom === next.bottom
				) {
					return prev
				}

				return next
			})
		}

		container.addEventListener('scroll', checkScroll, {
			passive: true
		})

		const ro = new ResizeObserver(checkScroll)
		if (contentRef.current) ro.observe(contentRef.current)
		ro.observe(container)

		const raf = requestAnimationFrame(checkScroll)

		return () => {
			container.removeEventListener('scroll', checkScroll)
			ro.disconnect()
			cancelAnimationFrame(raf)
		}
	}, [axis])

	return { containerRef, contentRef, fades }
}
