import { Eye, Table2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from '@/components/ui/tooltip'
import type { TableInfo } from '../types'

interface DbTableItemProps {
	table: TableInfo
	isActive: boolean
	onClick: () => void
}

export function DbTableItem({
	table,
	isActive,
	onClick
}: DbTableItemProps) {
	const Icon =
		table.type === 'view'
			? Eye
			: table.isVirtual
				? Zap
				: Table2

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						className={cn(
							'flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-xs hover:bg-sidebar-accent transition-colors',
							isActive &&
								'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
						)}
					/>
				}
			>
				<Icon className="size-3 text-muted-foreground shrink-0" />
				<span className="truncate">{table.name}</span>
				{table.isVirtual && (
					<Badge
						variant="outline"
						className="ml-auto text-[9px] px-1 py-0 h-3.5"
					>
						virtual
					</Badge>
				)}
				{table.type === 'view' && (
					<Badge
						variant="outline"
						className="ml-auto text-[9px] px-1 py-0 h-3.5"
					>
						view
					</Badge>
				)}
			</TooltipTrigger>
			<TooltipContent side="right">
				{table.name}
				{table.isVirtual && ' (virtual table)'}
				{table.type === 'view' && ' (view)'}
			</TooltipContent>
		</Tooltip>
	)
}
