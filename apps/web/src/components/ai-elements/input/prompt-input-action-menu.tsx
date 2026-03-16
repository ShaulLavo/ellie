import type { ComponentProps } from 'react'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ImageIcon, PlusIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import {
	PromptInputButton,
	type PromptInputButtonProps
} from './prompt-input-button'
import { usePromptInputAttachments } from './contexts'

export type PromptInputActionMenuProps = ComponentProps<
	typeof DropdownMenu
>
export const PromptInputActionMenu = (
	props: PromptInputActionMenuProps
) => <DropdownMenu {...props} />

export type PromptInputActionMenuTriggerProps =
	PromptInputButtonProps

export const PromptInputActionMenuTrigger = ({
	className,
	children,
	...props
}: PromptInputActionMenuTriggerProps) => (
	<DropdownMenuTrigger>
		<PromptInputButton className={className} {...props}>
			{children ?? <PlusIcon className="size-4" />}
		</PromptInputButton>
	</DropdownMenuTrigger>
)

export type PromptInputActionMenuContentProps =
	ComponentProps<typeof DropdownMenuContent>
export const PromptInputActionMenuContent = ({
	className,
	...props
}: PromptInputActionMenuContentProps) => (
	<DropdownMenuContent
		align="start"
		className={cn(className)}
		{...props}
	/>
)

export type PromptInputActionMenuItemProps = ComponentProps<
	typeof DropdownMenuItem
>
export const PromptInputActionMenuItem = ({
	className,
	...props
}: PromptInputActionMenuItemProps) => (
	<DropdownMenuItem className={cn(className)} {...props} />
)

export type PromptInputActionAddAttachmentsProps =
	ComponentProps<typeof DropdownMenuItem> & {
		label?: string
	}

export const PromptInputActionAddAttachments = ({
	label = 'Add photos or files',
	...props
}: PromptInputActionAddAttachmentsProps) => {
	const attachments = usePromptInputAttachments()

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault()
		attachments.openFileDialog()
	}

	return (
		<DropdownMenuItem {...props} onClick={handleClick}>
			<ImageIcon className="mr-2 size-4" /> {label}
		</DropdownMenuItem>
	)
}
