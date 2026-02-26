import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList
} from '@/components/ui/command'
import { Trash2Icon } from 'lucide-react'

export interface SlashCommand {
	name: string
	description: string
	icon?: React.ReactNode
	action: () => void
}

interface SlashCommandMenuProps {
	commands: SlashCommand[]
	inputValue: string
	onSelect: (command: SlashCommand) => void
}

export function SlashCommandMenu({
	commands,
	inputValue,
	onSelect
}: SlashCommandMenuProps) {
	const isSlashInput =
		inputValue.startsWith('/') && !inputValue.includes(' ')
	const open = isSlashInput
	const search = isSlashInput ? inputValue.slice(1) : ''

	const filtered = commands.filter(cmd =>
		cmd.name.toLowerCase().includes(search.toLowerCase())
	)

	if (!open || filtered.length === 0) return null

	return (
		<div className="absolute bottom-full left-0 right-0 z-50 mb-2">
			<Command className="rounded-lg border shadow-md bg-popover">
				<CommandList>
					<CommandGroup heading="Commands">
						{filtered.map(cmd => (
							<CommandItem
								key={cmd.name}
								value={cmd.name}
								onSelect={() => onSelect(cmd)}
							>
								{cmd.icon ?? (
									<Trash2Icon className="size-4" />
								)}
								<div className="flex flex-col">
									<span className="font-medium">
										/{cmd.name}
									</span>
									<span className="text-xs text-muted-foreground">
										{cmd.description}
									</span>
								</div>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</div>
	)
}
