import { useCallback, useEffect, useRef, useState } from 'react'

interface UseCopyToClipboardOptions {
	timeout?: number
	onCopy?: () => void
	onError?: (error: Error) => void
}

export function useCopyToClipboard(
	getText: string | (() => string),
	options: UseCopyToClipboardOptions = {}
) {
	const { timeout = 2000, onCopy, onError } = options
	const [isCopied, setIsCopied] = useState(false)
	const timeoutRef = useRef<number>(0)

	const copy = useCallback(async () => {
		if (
			typeof window === 'undefined' ||
			!navigator?.clipboard?.writeText
		) {
			onError?.(new Error('Clipboard API not available'))
			return
		}

		if (isCopied) return

		try {
			const text =
				typeof getText === 'function'
					? getText()
					: getText
			await navigator.clipboard.writeText(text)
			setIsCopied(true)
			onCopy?.()
			timeoutRef.current = window.setTimeout(
				() => setIsCopied(false),
				timeout
			)
		} catch (error) {
			onError?.(error as Error)
		}
	}, [getText, onCopy, onError, timeout, isCopied])

	useEffect(
		() => () => {
			window.clearTimeout(timeoutRef.current)
		},
		[]
	)

	return { isCopied, copy } as const
}
