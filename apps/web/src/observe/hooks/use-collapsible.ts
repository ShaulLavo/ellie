import { useState } from 'react'

export function useCollapsible(defaultCollapsed: boolean) {
	const [collapsed, setCollapsed] = useState(
		defaultCollapsed
	)
	const toggle = () => setCollapsed(c => !c)
	return { collapsed, toggle }
}
