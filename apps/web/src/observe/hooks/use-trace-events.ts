import { useQuery } from '@tanstack/react-query'
import { eden } from '../../lib/eden'

export function useTraceEvents(
	traceId: string | undefined
) {
	return useQuery({
		queryKey: ['traces', 'events', traceId],
		queryFn: async () => {
			if (!traceId) return []
			const res = await eden.api
				.traces({ traceId })
				.events.get()
			if (res.error) throw new Error(String(res.error))
			return res.data
		},
		enabled: !!traceId
	})
}
