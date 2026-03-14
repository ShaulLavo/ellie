import { useObserve } from './hooks/use-observe'
import { TraceEventView } from './trace-event-view'

export function ObservePage() {
	const {
		currentTrace,
		events,
		index,
		total,
		hasPrev,
		hasNext,
		prev,
		next,
		isLoading
	} = useObserve()

	if (isLoading && !events) {
		return (
			<div className="h-screen flex items-center justify-center text-zinc-400">
				Loading traces...
			</div>
		)
	}

	if (total === 0) {
		return (
			<div className="h-screen flex items-center justify-center text-zinc-400">
				No traces found.
			</div>
		)
	}

	return (
		<div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
			<header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
				<div className="flex items-center gap-3">
					<button
						onClick={prev}
						disabled={!hasPrev}
						className="px-3 py-1 text-sm rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
					>
						Prev
					</button>
					<span className="text-sm text-zinc-400 tabular-nums">
						{index + 1} / {total}
					</span>
					<button
						onClick={next}
						disabled={!hasNext}
						className="px-3 py-1 text-sm rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
					>
						Next
					</button>
				</div>
				{currentTrace && (
					<div className="text-xs text-zinc-500 flex gap-4">
						<span>{currentTrace.traceKind}</span>
						<span>
							{new Date(
								currentTrace.createdAt
							).toLocaleString()}
						</span>
						<span className="font-mono">
							{currentTrace.traceId.slice(0, 12)}...
						</span>
					</div>
				)}
			</header>
			<main className="flex-1 overflow-auto p-4">
				{events?.map(event => (
					<TraceEventView
						key={event.eventId}
						event={event}
					/>
				))}
			</main>
		</div>
	)
}
