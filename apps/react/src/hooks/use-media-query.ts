import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		subscribe => {
			const mql = window.matchMedia(query)
			mql.addEventListener('change', subscribe)
			return () =>
				mql.removeEventListener('change', subscribe)
		},
		() => window.matchMedia(query).matches,
		() => false
	)
}
