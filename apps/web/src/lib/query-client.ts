import { QueryClient } from '@tanstack/react-query'

// Persist across HMR re-evaluations
export const queryClient: QueryClient = ((
	globalThis as unknown as Record<string, QueryClient>
).__queryClient ??= new QueryClient({
	defaultOptions: {
		queries: {
			gcTime: 1000 * 60 * 60 * 24, // 24 hours
			staleTime: 1000 * 30,
			refetchOnWindowFocus: true
		}
	}
}))
