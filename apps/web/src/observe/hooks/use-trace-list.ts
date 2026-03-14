import { useQuery } from '@tanstack/react-query'
import { eden } from '../../lib/eden'

export function useTraceList() {
	return useQuery({
		queryKey: ['traces', 'list'],
		queryFn: async () => {
			const res = await eden.traces.list.get()
			if (res.error) throw new Error(String(res.error))
			return res.data
		}
	})
}
