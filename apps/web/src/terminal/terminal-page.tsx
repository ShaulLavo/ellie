import { useRef } from 'react'
import { useTerminal } from './hooks/use-terminal'
import { darkTermTheme } from './utils'

export function TerminalPage() {
	const containerRef = useRef<HTMLDivElement>(null)
	useTerminal(containerRef)

	return (
		<div
			ref={containerRef}
			className="h-screen w-screen relative overflow-hidden"
			style={{ backgroundColor: darkTermTheme.background }}
		/>
	)
}
