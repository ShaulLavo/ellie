import { useMemo } from 'react'
import { ChevronRight, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger
} from '@/components/ui/collapsible'
import { useDbTables } from '../hooks/use-db-queries'
import { formatBytes } from '../utils'
import { DbTableItem } from './db-table-item'

interface DbDatabaseGroupProps {
	name: string
	sizeBytes: number
	isSelected: boolean
	selectedTable?: string
	onSelectTable: (table: string) => void
	showInternal: boolean
}

export function DbDatabaseGroup({
	name,
	sizeBytes,
	isSelected,
	selectedTable,
	onSelectTable,
	showInternal
}: DbDatabaseGroupProps) {
	const { data: tables, isLoading } = useDbTables(name)

	const visibleTables = useMemo(
		() =>
			showInternal
				? tables
				: tables?.filter(t => !t.isInternal),
		[tables, showInternal]
	)

	return (
		<Collapsible defaultOpen={isSelected || undefined}>
			<CollapsibleTrigger
				className={cn(
					'flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-sm hover:bg-sidebar-accent transition-colors group',
					isSelected && 'bg-sidebar-accent/50'
				)}
			>
				<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[open]:rotate-90" />
				<Database className="size-3.5 text-muted-foreground shrink-0" />
				<span className="truncate font-medium text-xs">
					{name}
				</span>
				<span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
					{formatBytes(sizeBytes)}
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="ml-3 pl-2.5 border-l border-border/50">
					{isLoading && (
						<div className="py-2 pl-2">
							<Spinner className="size-3 text-muted-foreground" />
						</div>
					)}
					{visibleTables?.map(t => (
						<DbTableItem
							key={t.name}
							table={t}
							isActive={selectedTable === t.name}
							onClick={() => onSelectTable(t.name)}
						/>
					))}
					{!isLoading && visibleTables?.length === 0 && (
						<p className="text-[10px] text-muted-foreground py-2 pl-2">
							No tables
						</p>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
