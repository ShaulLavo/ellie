import { useCallback, useState } from 'react'
import {
	useNavigate,
	useSearch
} from '@tanstack/react-router'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { DbSidebar } from './db-sidebar'
import { DbTableGrid } from './db-table-grid'
import { DbTableToolbar } from './db-table-toolbar'
import { DbEmptyState } from './db-empty-state'
import { ThemeToggle } from '@/components/theme-toggle'
import {
	useDbSchema,
	useDbRows
} from '../hooks/use-db-queries'

export function DbStudioPage() {
	const search = useSearch({ from: '/db' })
	const navigate = useNavigate({ from: '/db' })

	const { database, table } = search
	const page = search.page ?? 1
	const pageSize = search.pageSize ?? 100
	const sortBy = search.sortBy
	const sortDir = (search.sortDir ?? 'asc') as
		| 'asc'
		| 'desc'
	const filter = search.filter

	const { data: schema } = useDbSchema(database, table)
	const { data: rows, isLoading: rowsLoading } = useDbRows(
		database,
		table,
		{ page, pageSize, sortBy, sortDir, filter }
	)

	const updateSearch = useCallback(
		(
			updates: Record<string, unknown>,
			resetPage = false
		) => {
			navigate({
				search: prev => ({
					...prev,
					...updates,
					...(resetPage ? { page: undefined } : {})
				})
			})
		},
		[navigate]
	)

	const handleSelectTable = useCallback(
		(db: string, tbl: string) => {
			navigate({
				search: {
					database: db,
					table: tbl,
					page: undefined,
					pageSize: search.pageSize,
					sortBy: undefined,
					sortDir: undefined,
					filter: undefined
				}
			})
		},
		[navigate, search.pageSize]
	)

	const handleSort = useCallback(
		(column: string) => {
			if (sortBy === column) {
				updateSearch(
					{
						sortDir: sortDir === 'asc' ? 'desc' : 'asc'
					},
					true
				)
			} else {
				updateSearch(
					{ sortBy: column, sortDir: 'asc' },
					true
				)
			}
		},
		[sortBy, sortDir, updateSearch]
	)

	const [isCollapsed, setIsCollapsed] = useState(false)

	return (
		<div className="h-screen flex flex-col overflow-hidden bg-background">
			{/* Header */}
			<header className="flex items-center gap-3 px-4 h-11 border-b bg-card/50 shrink-0">
				<button
					onClick={() => setIsCollapsed(v => !v)}
					className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					title={
						isCollapsed ? 'Show sidebar' : 'Hide sidebar'
					}
				>
					{isCollapsed ? (
						<PanelLeftOpen className="size-3.5" />
					) : (
						<PanelLeftClose className="size-3.5" />
					)}
				</button>
				<Separator orientation="vertical" className="h-4" />
				{database && table ? (
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<span className="font-mono">{database}</span>
						<span>/</span>
						<span className="font-mono font-medium text-foreground">
							{table}
						</span>
						{rows && (
							<span className="ml-1 tabular-nums">
								({rows.totalRows.toLocaleString()} rows)
							</span>
						)}
					</div>
				) : (
					<span className="text-xs text-muted-foreground">
						Select a table to browse
					</span>
				)}
				<div className="ml-auto flex items-center gap-1">
					<ThemeToggle />
				</div>
			</header>

			{/* Body */}
			<div className="flex flex-1 overflow-hidden">
				{!isCollapsed && (
					<DbSidebar
						selectedDatabase={database}
						selectedTable={table}
						onSelect={handleSelectTable}
					/>
				)}
				<main className="flex-1 flex flex-col overflow-hidden">
					{database && table && schema ? (
						<>
							<DbTableToolbar
								columns={schema.columns}
								activeFilter={filter}
								onApplyFilter={f =>
									updateSearch({ filter: f }, true)
								}
							/>
							<DbTableGrid
								schema={schema}
								rows={rows}
								isLoading={rowsLoading}
								sortBy={sortBy}
								sortDir={sortDir}
								onSort={handleSort}
								page={page}
								pageSize={pageSize}
								onPageChange={p =>
									updateSearch({
										page: p
									})
								}
								onPageSizeChange={s =>
									updateSearch({ pageSize: s }, true)
								}
							/>
						</>
					) : (
						<DbEmptyState />
					)}
				</main>
			</div>
		</div>
	)
}
