import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Filter, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ColumnInfo } from '../types'

interface DbTableToolbarProps {
	columns: ColumnInfo[]
	activeFilter?: string
	onApplyFilter: (filter: string | undefined) => void
}

const DEBOUNCE_MS = 300

const OPERATORS = [
	{ value: 'contains', label: 'contains' },
	{ value: 'eq', label: 'equals' },
	{ value: 'gt', label: '>' },
	{ value: 'lt', label: '<' }
] as const

export function DbTableToolbar({
	columns,
	activeFilter,
	onApplyFilter
}: DbTableToolbarProps) {
	const visibleColumns = columns.filter(c => !c.hidden)

	// Parse existing filter from URL
	const parsed = activeFilter
		? parseFilterString(activeFilter)
		: null
	const [column, setColumn] = useState(
		parsed?.column ?? visibleColumns[0]?.name ?? ''
	)
	const [operator, setOperator] = useState(
		parsed?.op ?? 'contains'
	)
	const [value, setValue] = useState(parsed?.value ?? '')

	// Track whether we should skip the next debounce (for clear action)
	const skipDebounce = useRef(false)

	// Sync local state when activeFilter changes externally (e.g. URL navigation)
	const prevFilter = useRef(activeFilter)
	useEffect(() => {
		if (activeFilter !== prevFilter.current) {
			prevFilter.current = activeFilter
			if (activeFilter) {
				const p = parseFilterString(activeFilter)
				if (p) {
					setColumn(p.column)
					setOperator(p.op)
					setValue(p.value)
				}
			} else {
				setValue('')
			}
		}
	}, [activeFilter])

	// Debounced auto-apply when column, operator, or value change
	useEffect(() => {
		if (skipDebounce.current) {
			skipDebounce.current = false
			return
		}

		const trimmed = value.trim()
		if (!trimmed) {
			// Only clear if there's an active filter
			if (activeFilter) {
				const timer = setTimeout(() => {
					onApplyFilter(undefined)
				}, DEBOUNCE_MS)
				return () => clearTimeout(timer)
			}
			return
		}

		const newFilter = `${column}:${operator}:${trimmed}`
		if (newFilter === activeFilter) return

		const timer = setTimeout(() => {
			onApplyFilter(newFilter)
		}, DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [column, operator, value])

	function handleClear() {
		skipDebounce.current = true
		setValue('')
		onApplyFilter(undefined)
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault()
			const trimmed = value.trim()
			if (trimmed && column) {
				skipDebounce.current = true
				onApplyFilter(`${column}:${operator}:${trimmed}`)
			}
		}
		if (e.key === 'Escape') {
			handleClear()
		}
	}

	const operatorLabel =
		OPERATORS.find(o => o.value === operator)?.label ??
		operator

	return (
		<div className="flex items-center gap-2 px-3 py-2 border-b bg-card/50">
			<Filter className="size-3.5 text-muted-foreground shrink-0" />

			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<button
							type="button"
							className="inline-flex items-center gap-1 h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring hover:bg-accent transition-colors"
						/>
					}
				>
					<span className="truncate max-w-28">
						{column}
					</span>
					<ChevronDown className="size-3 text-muted-foreground shrink-0" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuRadioGroup
						value={column}
						onValueChange={v => setColumn(v as string)}
					>
						{visibleColumns.map(c => (
							<DropdownMenuRadioItem
								key={c.name}
								value={c.name}
							>
								{c.name}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<button
							type="button"
							className="inline-flex items-center gap-1 h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring hover:bg-accent transition-colors"
						/>
					}
				>
					<span>{operatorLabel}</span>
					<ChevronDown className="size-3 text-muted-foreground shrink-0" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuRadioGroup
						value={operator}
						onValueChange={v => setOperator(v as string)}
					>
						{OPERATORS.map(op => (
							<DropdownMenuRadioItem
								key={op.value}
								value={op.value}
							>
								{op.label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			<div className="relative">
				<Input
					className="h-7 w-48 text-xs pr-7"
					placeholder="Filter..."
					value={value}
					onChange={e => setValue(e.target.value)}
					onKeyDown={handleKeyDown}
				/>
				{value && (
					<button
						onClick={handleClear}
						className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
						type="button"
					>
						<X className="size-3" />
					</button>
				)}
			</div>
		</div>
	)
}

function parseFilterString(
	filter: string
): { column: string; op: string; value: string } | null {
	const parts = filter.split(':')
	if (parts.length < 3) return null
	return {
		column: parts[0],
		op: parts[1],
		value: parts.slice(2).join(':')
	}
}
