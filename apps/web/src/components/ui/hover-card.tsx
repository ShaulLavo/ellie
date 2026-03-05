import { Popover as PopoverPrimitive } from '@base-ui/react/popover'

import { cn } from '@/lib/utils'

function HoverCard({
	openDelay: _openDelay,
	closeDelay: _closeDelay,
	...props
}: PopoverPrimitive.Root.Props & {
	openDelay?: number
	closeDelay?: number
}) {
	return (
		<PopoverPrimitive.Root
			data-slot="hover-card"
			{...props}
		/>
	)
}

function HoverCardTrigger({
	...props
}: PopoverPrimitive.Trigger.Props) {
	return (
		<PopoverPrimitive.Trigger
			data-slot="hover-card-trigger"
			openOnHover
			{...props}
		/>
	)
}

function HoverCardContent({
	className,
	align = 'center',
	sideOffset = 4,
	side,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		'align' | 'sideOffset' | 'side'
	>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				sideOffset={sideOffset}
				side={side}
			>
				<PopoverPrimitive.Popup
					data-slot="hover-card-content"
					className={cn(
						'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--transform-origin) rounded-md border p-4 shadow-md outline-hidden',
						className
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	)
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
