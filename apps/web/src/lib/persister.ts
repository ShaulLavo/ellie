import { get, set, del } from 'idb-keyval'
import type {
	PersistedClient,
	Persister
} from '@tanstack/react-query-persist-client'

const IDB_KEY = 'ellie-query-cache'

export const idbPersister: Persister = {
	persistClient: async (client: PersistedClient) => {
		await set(IDB_KEY, client)
	},
	restoreClient: async () => {
		return await get<PersistedClient>(IDB_KEY)
	},
	removeClient: async () => {
		await del(IDB_KEY)
	}
}
