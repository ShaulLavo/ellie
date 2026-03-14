import { useCollapsible } from './hooks/use-collapsible'

export function JsonBlock({ value }: { value: unknown }) {
	const json = JSON.stringify(value, null, 2)
	const isLarge = json.length > 500
	const { collapsed, toggle } = useCollapsible(isLarge)

	if (isLarge && collapsed) {
		return (
			<button
				onClick={toggle}
				className="text-xs text-zinc-500 hover:text-zinc-300 font-mono"
			>
				{jsonPreview(value)} (click to expand)
			</button>
		)
	}

	return (
		<div>
			{isLarge && (
				<button
					onClick={toggle}
					className="text-xs text-zinc-500 hover:text-zinc-300 mb-1 block"
				>
					(collapse)
				</button>
			)}
			<pre className="text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
				{json}
			</pre>
		</div>
	)
}

function jsonPreview(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length} items]`
	if (typeof value === 'object' && value !== null)
		return `{${Object.keys(value).length} keys}`
	return String(value).slice(0, 60)
}
