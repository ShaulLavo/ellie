import { Streamdown } from 'streamdown'
import { streamdownPlugins } from '@/hooks/use-streamdown-plugins'
import { useCollapsible } from './hooks/use-collapsible'

export function MarkdownBlock({
	value
}: {
	value: string
}) {
	const isLarge = value.length > 2000
	const { collapsed, toggle } = useCollapsible(isLarge)

	if (isLarge && collapsed) {
		return (
			<button
				onClick={toggle}
				className="text-xs text-zinc-500 hover:text-zinc-300 font-mono"
			>
				{value.slice(0, 80)}... ({value.length} chars, click
				to expand)
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
			<Streamdown
				className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2"
				plugins={streamdownPlugins}
			>
				{value}
			</Streamdown>
		</div>
	)
}
