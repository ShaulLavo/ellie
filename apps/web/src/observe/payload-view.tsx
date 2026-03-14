import { MarkdownBlock } from './markdown-block'
import { JsonBlock } from './json-block'

export function PayloadView({
	payload
}: {
	payload: unknown
}) {
	if (payload == null) return null

	if (typeof payload === 'string') {
		return <MarkdownBlock value={payload} />
	}

	if (
		typeof payload !== 'object' ||
		Array.isArray(payload)
	) {
		return <JsonBlock value={payload} />
	}

	const entries = Object.entries(
		payload as Record<string, unknown>
	)

	return (
		<div className="space-y-2">
			{entries.map(([key, value]) => (
				<div key={key}>
					<span className="text-xs font-mono text-zinc-500">
						{key}
					</span>
					{typeof value === 'string' &&
					value.length > 80 ? (
						<MarkdownBlock value={value} />
					) : (
						<JsonBlock value={value} />
					)}
				</div>
			))}
		</div>
	)
}
