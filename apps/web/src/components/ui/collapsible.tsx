import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'

function Collapsible({
	render,
	...props
}: CollapsiblePrimitive.Root.Props & {
	render?: React.ReactElement
}) {
	return (
		<CollapsiblePrimitive.Root
			data-slot="collapsible"
			{...(render ? { render } : {})}
			{...props}
		/>
	)
}

function CollapsibleTrigger({
	render,
	children,
	...props
}: CollapsiblePrimitive.Trigger.Props & {
	render?: React.ReactElement
}) {
	return (
		<CollapsiblePrimitive.Trigger
			data-slot="collapsible-trigger"
			{...(render ? { render } : {})}
			{...props}
		>
			{render ? undefined : children}
		</CollapsiblePrimitive.Trigger>
	)
}

function CollapsibleContent({
	render,
	children,
	...props
}: CollapsiblePrimitive.Panel.Props & {
	render?: React.ReactElement
}) {
	return (
		<CollapsiblePrimitive.Panel
			data-slot="collapsible-content"
			{...(render ? { render } : {})}
			{...props}
		>
			{render ? undefined : children}
		</CollapsiblePrimitive.Panel>
	)
}

export {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent
}
