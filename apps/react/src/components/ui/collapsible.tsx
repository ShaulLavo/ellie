import {
	Collapsible as CollapsiblePrimitive,
	Slot
} from 'radix-ui'

function Collapsible({
	render,
	...props
}: React.ComponentProps<
	typeof CollapsiblePrimitive.Root
> & {
	render?: React.ReactElement
}) {
	return (
		<CollapsiblePrimitive.Root
			data-slot="collapsible"
			asChild={!!render}
			{...props}
		>
			{render ? (
				<Slot.Root>
					{render}
					{props.children}
				</Slot.Root>
			) : (
				props.children
			)}
		</CollapsiblePrimitive.Root>
	)
}

function CollapsibleTrigger({
	render,
	children,
	...props
}: React.ComponentProps<
	typeof CollapsiblePrimitive.CollapsibleTrigger
> & {
	render?: React.ReactElement
}) {
	if (render) {
		return (
			<CollapsiblePrimitive.CollapsibleTrigger
				data-slot="collapsible-trigger"
				asChild
				{...props}
			>
				{render}
			</CollapsiblePrimitive.CollapsibleTrigger>
		)
	}
	return (
		<CollapsiblePrimitive.CollapsibleTrigger
			data-slot="collapsible-trigger"
			{...props}
		>
			{children}
		</CollapsiblePrimitive.CollapsibleTrigger>
	)
}

function CollapsibleContent({
	render,
	children,
	...props
}: React.ComponentProps<
	typeof CollapsiblePrimitive.CollapsibleContent
> & {
	render?: React.ReactElement
}) {
	if (render) {
		return (
			<CollapsiblePrimitive.CollapsibleContent
				data-slot="collapsible-content"
				asChild
				{...props}
			>
				{render}
			</CollapsiblePrimitive.CollapsibleContent>
		)
	}
	return (
		<CollapsiblePrimitive.CollapsibleContent
			data-slot="collapsible-content"
			{...props}
		>
			{children}
		</CollapsiblePrimitive.CollapsibleContent>
	)
}

export {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent
}
