import { PayloadView } from './payload-view'

interface TraceEventViewProps {
	event: {
		eventId: string
		kind: string
		ts: number
		seq: number
		component: string
		payload: unknown
	}
}

export function TraceEventView({
	event
}: TraceEventViewProps) {
	return (
		<div className="mb-2 border border-zinc-800 rounded p-3">
			<div className="flex items-center gap-3 text-xs text-zinc-500 mb-2">
				<span className="font-mono font-semibold text-zinc-300">
					{event.kind}
				</span>
				<span>seq={event.seq}</span>
				<span>{event.component}</span>
				<span>
					{new Date(event.ts).toLocaleTimeString()}
				</span>
			</div>
			<PayloadView payload={event.payload} />
		</div>
	)
}
