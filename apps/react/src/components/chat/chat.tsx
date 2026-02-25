import { cn } from '@/lib/utils'

export interface ChatProps extends React.ComponentProps<'div'> {
	children?: React.ReactNode
}

export function Chat({
	children,
	className,
	...props
}: ChatProps) {
	return (
		<div
			className={cn(
				'h-full overflow-hidden flex flex-col @container/chat',
				className
			)}
			{...props}
		>
			{children}
		</div>
	)
}
