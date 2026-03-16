import { useEffect, useRef, useState } from 'react'

/**
 * Detects when files are being dragged over the document.
 * Returns true while a file drag is hovering over the window.
 *
 * Uses a counter to handle nested dragenter/dragleave events correctly.
 */
export function useFileDragOver() {
	const [isDragging, setIsDragging] = useState(false)
	const counterRef = useRef(0)

	useEffect(() => {
		const handleDragEnter = (e: DragEvent) => {
			if (!e.dataTransfer?.types?.includes('Files')) return
			e.preventDefault()
			counterRef.current += 1
			if (counterRef.current === 1) {
				setIsDragging(true)
			}
		}

		const handleDragLeave = (e: DragEvent) => {
			if (!e.dataTransfer?.types?.includes('Files')) return
			e.preventDefault()
			counterRef.current -= 1
			if (counterRef.current === 0) {
				setIsDragging(false)
			}
		}

		const handleDragOver = (e: DragEvent) => {
			if (!e.dataTransfer?.types?.includes('Files')) return
			e.preventDefault()
		}

		const handleDrop = () => {
			counterRef.current = 0
			setIsDragging(false)
		}

		document.addEventListener('dragenter', handleDragEnter)
		document.addEventListener('dragleave', handleDragLeave)
		document.addEventListener('dragover', handleDragOver)
		document.addEventListener('drop', handleDrop)
		return () => {
			document.removeEventListener(
				'dragenter',
				handleDragEnter
			)
			document.removeEventListener(
				'dragleave',
				handleDragLeave
			)
			document.removeEventListener(
				'dragover',
				handleDragOver
			)
			document.removeEventListener('drop', handleDrop)
		}
	}, [])

	return isDragging
}
