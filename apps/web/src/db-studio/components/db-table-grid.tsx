import { useCallback, useMemo, useState } from 'react'
import {
	useReactTable,
	getCoreRowModel,
	flexRender,
	type ColumnDef
} from '@tanstack/react-table'
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronDown,
	KeyRound,
	ChevronsLeft,
	ChevronsRight,
	ChevronLeft,
	ChevronRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { CellDetailDialog } from './cell-detail-dialog'
import type {
	ColumnInfo,
	RowsResponse,
	SchemaResponse
} from '../types'

interface DbTableGridProps {
	schema: SchemaResponse
	rows: RowsResponse | undefined
	isLoading: boolean
	sortBy?: string
	sortDir: 'asc' | 'desc'
	onSort: (column: string) => void
	page: number
	pageSize: number
	onPageChange: (page: number) => void
	onPageSizeChange: (size: number) => void
}

export function DbTableGrid({
	schema,
	rows,
	isLoading,
	sortBy,
	sortDir,
	onSort,
	page,
	pageSize,
	onPageChange,
	onPageSizeChange
}: DbTableGridProps) {
	const visibleColumns = schema.columns.filter(
		c => !c.hidden
	)

	const [cellDialogOpen, setCellDialogOpen] =
		useState(false)
	const [cellDialogData, setCellDialogData] = useState<{
		column: ColumnInfo
		value: unknown
	} | null>(null)

	const openCellDialog = useCallback(
		(column: ColumnInfo, value: unknown) => {
			setCellDialogData({ column, value })
			setCellDialogOpen(true)
		},
		[]
	)

	const columns = useMemo<
		ColumnDef<Record<string, unknown>>[]
	>(
		() =>
			visibleColumns.map(col => ({
				accessorKey: col.name,
				header: () => (
					<ColumnHeader
						column={col}
						sortBy={sortBy}
						sortDir={sortDir}
						onSort={onSort}
					/>
				),
				cell: ({ getValue }) => (
					<CellValue
						value={getValue()}
						onExpand={v => openCellDialog(col, v)}
					/>
				)
			})),
		[visibleColumns, sortBy, sortDir, onSort]
	)

	const data = rows?.rows ?? []
	const totalRows = rows?.totalRows ?? 0
	const totalPages = rows?.totalPages ?? 1

	const table = useReactTable({
		data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		manualPagination: true,
		manualSorting: true,
		pageCount: totalPages,
		state: {
			pagination: {
				pageIndex: page - 1,
				pageSize
			}
		}
	})

	return (
		<div className="flex flex-col flex-1 overflow-hidden">
			{/* Table */}
			<div className="flex-1 overflow-auto relative">
				{isLoading && (
					<div className="absolute inset-0 bg-background/60 z-10 flex items-center justify-center">
						<Spinner className="size-5" />
					</div>
				)}
				<Table>
					<TableHeader className="sticky top-0 z-[5] bg-muted/80 backdrop-blur-sm">
						{table.getHeaderGroups().map(headerGroup => (
							<TableRow
								key={headerGroup.id}
								className="border-b-2"
							>
								{headerGroup.headers.map(header => (
									<TableHead
										key={header.id}
										className="h-8 px-2"
									>
										{flexRender(
											header.column.columnDef.header,
											header.getContext()
										)}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{data.length === 0 && !isLoading ? (
							<TableRow>
								<TableCell
									colSpan={columns.length}
									className="h-32 text-center text-muted-foreground"
								>
									No rows found
								</TableCell>
							</TableRow>
						) : (
							table.getRowModel().rows.map(row => (
								<TableRow key={row.id}>
									{row.getVisibleCells().map(cell => (
										<TableCell
											key={cell.id}
											className="py-1 px-2 max-w-80 truncate"
										>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext()
											)}
										</TableCell>
									))}
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>

			{/* Pagination — adapted from table-example.tsx */}
			<div className="flex items-center justify-between px-3 py-2 border-t bg-muted/80">
				<div className="text-xs text-muted-foreground tabular-nums">
					{totalRows.toLocaleString()} row
					{totalRows !== 1 ? 's' : ''}
				</div>
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-1.5">
						<span className="text-xs text-muted-foreground">
							Rows per page
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<button
										type="button"
										className="inline-flex items-center gap-1 h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring hover:bg-accent transition-colors"
									/>
								}
							>
								<span>{pageSize}</span>
								<ChevronDown className="size-3 text-muted-foreground shrink-0" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" side="top">
								<DropdownMenuRadioGroup
									value={String(pageSize)}
									onValueChange={v =>
										onPageSizeChange(Number(v))
									}
								>
									{[25, 50, 100, 250, 500].map(s => (
										<DropdownMenuRadioItem
											key={s}
											value={String(s)}
										>
											{s}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<div className="flex items-center justify-center text-xs tabular-nums text-muted-foreground min-w-20">
						Page {page} of {totalPages}
					</div>

					<div className="flex items-center gap-1">
						<Button
							variant="outline"
							size="icon"
							className="hidden size-7 lg:flex"
							onClick={() => onPageChange(1)}
							disabled={page <= 1}
						>
							<span className="sr-only">First page</span>
							<ChevronsLeft className="size-3.5" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							className="size-7"
							onClick={() => onPageChange(page - 1)}
							disabled={page <= 1}
						>
							<span className="sr-only">Previous page</span>
							<ChevronLeft className="size-3.5" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							className="size-7"
							onClick={() => onPageChange(page + 1)}
							disabled={page >= totalPages}
						>
							<span className="sr-only">Next page</span>
							<ChevronRight className="size-3.5" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							className="hidden size-7 lg:flex"
							onClick={() => onPageChange(totalPages)}
							disabled={page >= totalPages}
						>
							<span className="sr-only">Last page</span>
							<ChevronsRight className="size-3.5" />
						</Button>
					</div>
				</div>
			</div>

			<CellDetailDialog
				open={cellDialogOpen}
				onOpenChange={setCellDialogOpen}
				column={cellDialogData?.column ?? null}
				value={cellDialogData?.value}
			/>
		</div>
	)
}

// ── Column header with sort controls ─────────────────────────────────────────

function ColumnHeader({
	column,
	sortBy,
	sortDir,
	onSort
}: {
	column: ColumnInfo
	sortBy?: string
	sortDir: 'asc' | 'desc'
	onSort: (name: string) => void
}) {
	const isSorted = sortBy === column.name
	const SortIcon = isSorted
		? sortDir === 'asc'
			? ArrowUp
			: ArrowDown
		: ArrowUpDown

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => onSort(column.name)}
						className={cn(
							'flex items-center gap-1 text-xs font-medium select-none hover:text-foreground transition-colors',
							isSorted && 'text-foreground'
						)}
					/>
				}
			>
				{column.primaryKey && (
					<KeyRound className="size-3 text-primary shrink-0" />
				)}
				<span className="truncate">{column.name}</span>
				<SortIcon
					className={cn(
						'size-3 shrink-0',
						isSorted
							? 'text-foreground'
							: 'text-muted-foreground/50'
					)}
				/>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="text-xs">
				<div className="flex flex-col gap-0.5">
					<span className="font-mono">{column.name}</span>
					<span className="text-muted-foreground">
						{column.type}
						{column.notNull ? ' NOT NULL' : ''}
						{column.primaryKey ? ' PK' : ''}
						{column.unique ? ' UNIQUE' : ''}
					</span>
					{column.defaultValue !== null && (
						<span className="text-muted-foreground">
							Default: {column.defaultValue}
						</span>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	)
}

// ── Cell value rendering ─────────────────────────────────────────────────────

function CellValue({
	value,
	onExpand
}: {
	value: unknown
	onExpand: (value: unknown) => void
}) {
	if (value === null || value === undefined) {
		return (
			<span className="text-muted-foreground/60 italic text-xs font-mono">
				NULL
			</span>
		)
	}

	if (typeof value === 'boolean') {
		return (
			<Badge
				variant="outline"
				className="text-[10px] px-1.5 py-0 h-4 font-mono"
			>
				{String(value)}
			</Badge>
		)
	}

	if (typeof value === 'object') {
		const json = JSON.stringify(value)
		return (
			<span
				className="font-mono text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors truncate block"
				role="button"
				tabIndex={0}
				onClick={() => onExpand(value)}
				onKeyDown={e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						onExpand(value)
					}
				}}
			>
				{json}
			</span>
		)
	}

	const str = String(value)
	return (
		<span
			className="font-mono text-xs cursor-pointer hover:text-foreground transition-colors truncate block"
			role="button"
			tabIndex={0}
			onClick={() => onExpand(value)}
			onKeyDown={e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					onExpand(value)
				}
			}}
		>
			{str}
		</span>
	)
}
