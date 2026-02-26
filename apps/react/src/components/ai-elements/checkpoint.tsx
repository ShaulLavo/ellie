'use client'

import type { IconProps as PhosphorIconProps } from '@phosphor-icons/react'
import type { ComponentProps, HTMLAttributes } from 'react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BookmarkSimpleIcon } from '@phosphor-icons/react'

export type CheckpointProps = HTMLAttributes<HTMLDivElement>

export const Checkpoint = ({
	className,
	children,
	...props
}: CheckpointProps) => (
	<div
		className={cn(
			'flex items-center gap-0.5 overflow-hidden text-muted-foreground',
			className
		)}
		{...props}
	>
		{children}
		<Separator />
	</div>
)

export type CheckpointIconProps = PhosphorIconProps

export const CheckpointIcon = ({
	className,
	children,
	...props
}: CheckpointIconProps) =>
	children ?? (
		<BookmarkSimpleIcon
			className={cn('size-4 shrink-0', className)}
			{...props}
		/>
	)

export type CheckpointTriggerProps = ComponentProps<
	typeof Button
> & {
	tooltip?: string
}

export const CheckpointTrigger = ({
	children,
	variant = 'ghost',
	size = 'sm',
	tooltip,
	...props
}: CheckpointTriggerProps) =>
	tooltip ? (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						size={size}
						type="button"
						variant={variant}
						{...props}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent side="bottom">
				{tooltip}
			</TooltipContent>
		</Tooltip>
	) : (
		<Button
			size={size}
			type="button"
			variant={variant}
			{...props}
		>
			{children}
		</Button>
	)
