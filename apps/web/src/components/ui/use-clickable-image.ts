import { useEffect, useId, useState } from 'react'

export function useClickableImage() {
	const [isOpen, setIsOpen] = useState(false)
	const [loaded, setLoaded] = useState(false)
	const layoutId = useId()

	useEffect(() => {
		if (!isOpen) return

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			setIsOpen(false)
		}

		document.addEventListener('keydown', onKeyDown)

		return () =>
			document.removeEventListener('keydown', onKeyDown)
	}, [isOpen])

	return {
		closeImage: () => {
			if (!isOpen) return
			setIsOpen(false)
		},
		handleThumbnailLoad: () => setLoaded(true),
		isOpen,
		layoutId,
		loaded,
		openImage: () => setIsOpen(true)
	}
}
