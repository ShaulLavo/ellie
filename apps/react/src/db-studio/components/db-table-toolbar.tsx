import { useState } from 'react'
import { Filter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select'
import type { ColumnInfo } from '../types'

interface DbTableToolbarProps {
	columns: ColumnInfo[]
	activeFilter?: string
	onApplyFilter: (filter: string | undefined) => void
}

export function DbTableToolbar({
	columns,
	activeFilter,
	onApplyFilter
}: DbTableToolbarProps) {
	const visibleColumns = columns.filter(c => !c.hidden)

	// Parse existing filter
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

	function handleApply() {
		if (!column || !value.trim()) return
		onApplyFilter(`${column}:${operator}:${value.trim()}`)
	}

	function handleClear() {
		setValue('')
		onApplyFilter(undefined)
	}

	return (
		<div className="flex items-center gap-2 px-3 py-2 border-b bg-card/50">
			<Filter className="size-3.5 text-muted-foreground shrink-0" />

			<Select
				value={column}
				onValueChange={v => v && setColumn(v)}
			>
				<SelectTrigger className="h-7 w-36 text-xs">
					<SelectValue placeholder="Column" />
				</SelectTrigger>
				<SelectContent>
					{visibleColumns.map(c => (
						<SelectItem key={c.name} value={c.name}>
							{c.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select
				value={operator}
				onValueChange={v => v && setOperator(v)}
			>
				<SelectTrigger className="h-7 w-28 text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="eq">equals</SelectItem>
					<SelectItem value="contains">contains</SelectItem>
					<SelectItem value="gt">greater than</SelectItem>
					<SelectItem value="lt">less than</SelectItem>
				</SelectContent>
			</Select>

			<Input
				className="h-7 w-48 text-xs"
				placeholder="Value..."
				value={value}
				onChange={e => setValue(e.target.value)}
				onKeyDown={e => {
					if (e.key === 'Enter') handleApply()
				}}
			/>

			<Button
				variant="secondary"
				size="xs"
				onClick={handleApply}
				disabled={!column || !value.trim()}
			>
				Apply
			</Button>

			{activeFilter && (
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					onClick={handleClear}
				>
					<X className="size-3.5" />
				</Button>
			)}
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
