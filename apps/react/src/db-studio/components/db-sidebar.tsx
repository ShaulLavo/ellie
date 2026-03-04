import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useDbDatabases } from '../hooks/use-db-queries'
import { DbDatabaseGroup } from './db-database-group'

interface DbSidebarProps {
	selectedDatabase?: string
	selectedTable?: string
	onSelect: (database: string, table: string) => void
}

export function DbSidebar({
	selectedDatabase,
	selectedTable,
	onSelect
}: DbSidebarProps) {
	const { data: databases, isLoading } = useDbDatabases()

	return (
		<aside className="w-60 shrink-0 border-r bg-sidebar flex flex-col">
			<div className="px-3 py-2.5 border-b">
				<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Databases
				</span>
			</div>
			<ScrollArea className="flex-1">
				<div className="p-1.5">
					{isLoading && (
						<div className="flex items-center justify-center py-8">
							<Spinner className="size-4 text-muted-foreground" />
						</div>
					)}
					{databases?.map(db => (
						<DbDatabaseGroup
							key={db.name}
							name={db.name}
							sizeBytes={db.sizeBytes}
							isSelected={selectedDatabase === db.name}
							selectedTable={
								selectedDatabase === db.name
									? selectedTable
									: undefined
							}
							onSelectTable={table =>
								onSelect(db.name, table)
							}
						/>
					))}
					{!isLoading && databases?.length === 0 && (
						<p className="text-xs text-muted-foreground text-center py-8">
							No databases found
						</p>
					)}
				</div>
			</ScrollArea>
		</aside>
	)
}
