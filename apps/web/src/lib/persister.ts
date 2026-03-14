import type {
	PersistedClient,
	Persister
} from '@tanstack/react-query-persist-client'

const STORAGE_KEY = 'ellie-query-cache'

export const localStoragePersister: Persister = {
	persistClient: (client: PersistedClient) => {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify(client)
			)
		} catch {
			localStorage.removeItem(STORAGE_KEY)
		}
	},
	restoreClient: () => {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return undefined
		return JSON.parse(raw) as PersistedClient
	},
	removeClient: () => {
		localStorage.removeItem(STORAGE_KEY)
	}
}
