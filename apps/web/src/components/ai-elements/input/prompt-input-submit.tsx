import type { ComponentProps, MouseEvent } from 'react'
import { InputGroupButton } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
	ArrowElbowDownLeftIcon,
	SquareIcon,
	XIcon
} from '@phosphor-icons/react'
import type { ChatStatus } from './types'

export type PromptInputSubmitProps = ComponentProps<
	typeof InputGroupButton
> & {
	status?: ChatStatus
	onStop?: () => void
}

export const PromptInputSubmit = ({
	className,
	variant = 'default',
	size = 'icon-sm',
	status,
	onStop,
	onClick,
	children,
	...props
}: PromptInputSubmitProps) => {
	const isGenerating =
		status === 'submitted' || status === 'streaming'

	let Icon = <ArrowElbowDownLeftIcon className="size-4" />

	if (status === 'submitted') {
		Icon = <Spinner />
	} else if (status === 'streaming') {
		Icon = <SquareIcon className="size-4" />
	} else if (status === 'error') {
		Icon = <XIcon className="size-4" />
	}

	const handleClick = (
		e: MouseEvent<HTMLButtonElement>
	) => {
		if (!isGenerating || !onStop) {
			onClick?.(e)
			return
		}
		e.preventDefault()
		onStop()
	}

	return (
		<InputGroupButton
			aria-label={isGenerating ? 'Stop' : 'Submit'}
			className={cn(className)}
			onClick={handleClick}
			size={size}
			type={isGenerating && onStop ? 'button' : 'submit'}
			variant={variant}
			{...props}
		>
			{children ?? Icon}
		</InputGroupButton>
	)
}
