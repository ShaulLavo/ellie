import { DatabaseIcon, Table2 } from 'lucide-react'

export function DbEmptyState() {
	return (
		<div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
			<div className="relative">
				<Table2 className="size-12 text-muted-foreground/30" />
				<DatabaseIcon className="size-5 text-primary/50 absolute -bottom-1 -right-1" />
			</div>
			<div className="text-center">
				<p className="text-sm font-medium text-foreground/60">
					No table selected
				</p>
				<p className="text-xs mt-1">
					Pick a database and table from the sidebar
				</p>
			</div>
		</div>
	)
}
