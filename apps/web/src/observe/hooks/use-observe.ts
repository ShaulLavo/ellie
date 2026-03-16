import { useState } from 'react'
import { useTraceList } from './use-trace-list'
import { useTraceEvents } from './use-trace-events'

export function useObserve() {
	const { data: traces, isLoading: listLoading } =
		useTraceList()
	const [index, setIndex] = useState(-1)

	// Derive effective index — no effect needed
	const effectiveIndex =
		index === -1 && traces && traces.length > 0
			? traces.length - 1
			: index

	const currentTrace = traces?.[effectiveIndex]
	const { data: events, isLoading: eventsLoading } =
		useTraceEvents(currentTrace?.traceId)

	const hasPrev = effectiveIndex > 0
	const hasNext =
		!!traces && effectiveIndex < traces.length - 1

	const prev = () => {
		if (hasPrev) setIndex(effectiveIndex - 1)
	}
	const next = () => {
		if (hasNext) setIndex(effectiveIndex + 1)
	}

	return {
		traces,
		currentTrace,
		events,
		index: effectiveIndex,
		total: traces?.length ?? 0,
		hasPrev,
		hasNext,
		prev,
		next,
		isLoading: listLoading || eventsLoading
	}
}
