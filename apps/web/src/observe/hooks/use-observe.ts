import { useState, useEffect } from 'react'
import { useTraceList } from './use-trace-list'
import { useTraceEvents } from './use-trace-events'

export function useObserve() {
	const { data: traces, isLoading: listLoading } =
		useTraceList()
	const [index, setIndex] = useState(-1)

	// Start at the last trace once loaded
	useEffect(() => {
		if (traces && traces.length > 0 && index === -1) {
			setIndex(traces.length - 1)
		}
	}, [traces, index])

	const currentTrace = traces?.[index]
	const { data: events, isLoading: eventsLoading } =
		useTraceEvents(currentTrace?.traceId)

	const hasPrev = index > 0
	const hasNext = !!traces && index < traces.length - 1

	const prev = () => {
		if (hasPrev) setIndex(i => i - 1)
	}
	const next = () => {
		if (hasNext) setIndex(i => i + 1)
	}

	return {
		traces,
		currentTrace,
		events,
		index,
		total: traces?.length ?? 0,
		hasPrev,
		hasNext,
		prev,
		next,
		isLoading: listLoading || eventsLoading
	}
}
