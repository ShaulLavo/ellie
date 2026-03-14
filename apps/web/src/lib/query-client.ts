import { QueryClient } from '@tanstack/react-query'

// Persist across HMR re-evaluations
export const queryClient: QueryClient = ((
	globalThis as unknown as Record<string, QueryClient>
).__queryClient ??= new QueryClient({
	defaultOptions: {
		queries: {
			gcTime: Number.POSITIVE_INFINITY,
			staleTime: 1000 * 30,
			refetchOnWindowFocus: true
		}
	}
}))
