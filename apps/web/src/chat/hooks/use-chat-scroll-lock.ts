'use client'

import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState
} from 'react'

const STICK_TO_BOTTOM_OFFSET_PX = 70
type ScrollBehaviorMode = 'instant' | 'smooth'

function getDistanceFromBottom(element: HTMLDivElement) {
	return (
		element.scrollHeight -
		element.clientHeight -
		element.scrollTop
	)
}

function isNearBottom(element: HTMLDivElement) {
	return (
		getDistanceFromBottom(element) <=
		STICK_TO_BOTTOM_OFFSET_PX
	)
}

function getBottomScrollTop(element: HTMLDivElement) {
	return Math.max(
		0,
		element.scrollHeight - element.clientHeight
	)
}

export function useChatScrollLock() {
	const scrollRef = useRef<HTMLDivElement>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	const frameRef = useRef<number | null>(null)
	const lastScrollTopRef = useRef(0)
	const previousHeightRef = useRef<number | null>(null)
	const escapedRef = useRef(false)
	const pinnedRef = useRef(true)
	const keepPinnedRef = useRef(false)
	const hasPendingContentRef = useRef(false)
	const [showScrollButton, setShowScrollButton] =
		useState(false)

	function setButtonVisibility(next: boolean) {
		setShowScrollButton(prev =>
			prev === next ? prev : next
		)
	}

	function syncButtonVisibility() {
		const element = scrollRef.current
		if (!element) return

		if (isNearBottom(element)) {
			escapedRef.current = false
			pinnedRef.current = true
			hasPendingContentRef.current = false
			setButtonVisibility(false)
			return
		}

		setButtonVisibility(hasPendingContentRef.current)
	}

	function cancelScheduledScroll() {
		if (frameRef.current == null) return
		cancelAnimationFrame(frameRef.current)
		frameRef.current = null
	}

	function syncToBottom(
		behavior: ScrollBehaviorMode = 'instant'
	) {
		const element = scrollRef.current
		if (!element) return
		const top = getBottomScrollTop(element)
		if (behavior === 'smooth') {
			element.scrollTo({ top, behavior: 'smooth' })
		} else {
			element.scrollTop = top
		}
		lastScrollTopRef.current = element.scrollTop
	}

	function scrollToBottom(
		behavior: ScrollBehaviorMode = 'instant'
	) {
		cancelScheduledScroll()
		escapedRef.current = false
		pinnedRef.current = true
		setButtonVisibility(false)

		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null
			syncToBottom(behavior)
			syncButtonVisibility()
		})
	}

	useLayoutEffect(() => {
		const element = scrollRef.current
		if (!element) return
		element.scrollTop = getBottomScrollTop(element)
		lastScrollTopRef.current = element.scrollTop
	}, [])

	useEffect(() => {
		const element = scrollRef.current
		if (!element) return

		const handleScroll = () => {
			const currentScrollTop = element.scrollTop

			if (isNearBottom(element)) {
				escapedRef.current = false
				pinnedRef.current = true
				hasPendingContentRef.current = false
				setButtonVisibility(false)
				lastScrollTopRef.current = currentScrollTop
				return
			}

			if (currentScrollTop < lastScrollTopRef.current - 1) {
				escapedRef.current = true
				pinnedRef.current = false
			}

			lastScrollTopRef.current = currentScrollTop
			setButtonVisibility(hasPendingContentRef.current)
		}

		element.addEventListener('scroll', handleScroll, {
			passive: true
		})
		handleScroll()

		return () => {
			element.removeEventListener('scroll', handleScroll)
		}
	}, [])

	useEffect(() => {
		const content = contentRef.current
		if (!content) return

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]
			if (!entry) return

			const nextHeight = entry.contentRect.height
			const previousHeight = previousHeightRef.current
			previousHeightRef.current = nextHeight

			const element = scrollRef.current
			if (!element) return

			const bottomScrollTop = getBottomScrollTop(element)
			if (element.scrollTop > bottomScrollTop) {
				element.scrollTop = bottomScrollTop
			}

			if (previousHeight == null) {
				scrollToBottom()
				return
			}

			if (
				nextHeight > previousHeight &&
				(pinnedRef.current || keepPinnedRef.current) &&
				!escapedRef.current
			) {
				scrollToBottom('instant')
				return
			}

			if (
				nextHeight > previousHeight &&
				!pinnedRef.current
			) {
				hasPendingContentRef.current = true
			}

			if (nextHeight <= previousHeight) {
				keepPinnedRef.current = false
			}

			syncButtonVisibility()
		})

		observer.observe(content)

		return () => {
			observer.disconnect()
		}
	}, [])

	useEffect(() => {
		const content = contentRef.current
		if (!content) return

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!(target instanceof Element)) return
			if (
				!target.closest('[data-slot="collapsible-trigger"]')
			)
				return
			const element = scrollRef.current
			if (!element) return
			if (isNearBottom(element)) {
				escapedRef.current = false
				pinnedRef.current = true
				keepPinnedRef.current = true
				return
			}
			escapedRef.current = true
			pinnedRef.current = false
			keepPinnedRef.current = false
			setButtonVisibility(true)
		}

		content.addEventListener(
			'pointerdown',
			handlePointerDown,
			true
		)

		return () => {
			content.removeEventListener(
				'pointerdown',
				handlePointerDown,
				true
			)
		}
	}, [])

	useEffect(() => {
		return () => {
			cancelScheduledScroll()
		}
	}, [])

	return {
		scrollRef,
		contentRef,
		showScrollButton,
		scrollToBottom
	}
}
