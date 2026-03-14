import type { CSSProperties } from 'react'
import { thumbHashToDataURL } from '@ellie/utils'

const MAX_CHAT_IMAGE_HEIGHT_PX = 320

export function getClickableImagePlaceholderUrl(
	hash?: string
) {
	if (!hash) return undefined

	try {
		const bytes = Uint8Array.from(atob(hash), char =>
			char.charCodeAt(0)
		)
		return thumbHashToDataURL(bytes)
	} catch {
		return undefined
	}
}

export function getClickableImageContainerStyle({
	naturalHeight,
	naturalWidth
}: {
	naturalHeight?: number
	naturalWidth?: number
}): CSSProperties | undefined {
	if (!naturalWidth || !naturalHeight) return undefined

	const aspectRatio = `${naturalWidth} / ${naturalHeight}`
	const boundedWidth = Math.min(
		naturalWidth,
		(naturalWidth / naturalHeight) *
			MAX_CHAT_IMAGE_HEIGHT_PX
	)

	return {
		aspectRatio,
		width: `min(100%, ${boundedWidth}px)`
	}
}

export function getClickableImagePlaceholderStyle(
	placeholderUrl?: string
): CSSProperties | undefined {
	if (!placeholderUrl) return undefined

	return {
		backgroundImage: `url(${placeholderUrl})`,
		backgroundSize: 'cover'
	}
}
