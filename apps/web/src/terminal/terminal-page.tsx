import { useEffect, useRef, useState } from 'react'
import type {
	Terminal as GhosttyTerminal,
	FitAddon
} from 'ghostty-web'
import { eden } from '@/lib/eden'

type TerminalWS = ReturnType<
	typeof eden.ws.terminal.subscribe
>
type Status =
	| 'loading'
	| 'connecting'
	| 'connected'
	| 'disconnected'

/**
 * Convert a wheel event into SGR mouse escape sequences.
 * The TUI enables SGR extended mouse mode (\x1b[?1006h),
 * which expects: \x1b[<button;col;rowM
 *   button 64 = scroll up, 65 = scroll down
 */
function wheelToMouseSequences(
	e: WheelEvent,
	term: GhosttyTerminal
): string | null {
	const canvas = e.target as HTMLElement
	const rect = canvas.getBoundingClientRect()
	const cellWidth = rect.width / term.cols
	const cellHeight = rect.height / term.rows

	const col =
		Math.floor((e.clientX - rect.left) / cellWidth) + 1
	const row =
		Math.floor((e.clientY - rect.top) / cellHeight) + 1

	if (
		col < 1 ||
		row < 1 ||
		col > term.cols ||
		row > term.rows
	)
		return null

	const button = e.deltaY < 0 ? 64 : 65
	const seq = `\x1b[<${button};${col};${row}M`
	return seq
}

export function TerminalPage() {
	const containerRef = useRef<HTMLDivElement>(null)
	const [status, setStatus] = useState<Status>('loading')

	useEffect(() => {
		let term: GhosttyTerminal | null = null
		let fitAddon: FitAddon | null = null
		let ws: TerminalWS | null = null
		let observer: ResizeObserver | null = null
		let wheelHandler: ((e: WheelEvent) => void) | null =
			null
		let clickHandler: (() => void) | null = null
		let disposed = false

		async function setup() {
			if (!containerRef.current || disposed) return

			const { init, Terminal, FitAddon } =
				await import('ghostty-web')

			await init()
			if (disposed) return

			term = new Terminal({
				fontSize: 14,
				fontFamily:
					"'JetBrains Mono Variable', 'JetBrains Mono', monospace",
				cursorBlink: true,
				scrollback: 10_000,
				theme: {
					background: '#0a0a0a',
					foreground: '#e4e4e7',
					cursor: '#e4e4e7',
					cursorAccent: '#0a0a0a',
					selectionBackground: '#27272a',
					black: '#18181b',
					red: '#f87171',
					green: '#4ade80',
					yellow: '#facc15',
					blue: '#60a5fa',
					magenta: '#c084fc',
					cyan: '#22d3ee',
					white: '#e4e4e7',
					brightBlack: '#52525b',
					brightRed: '#fca5a5',
					brightGreen: '#86efac',
					brightYellow: '#fde68a',
					brightBlue: '#93c5fd',
					brightMagenta: '#d8b4fe',
					brightCyan: '#67e8f9',
					brightWhite: '#fafafa'
				}
			})

			fitAddon = new FitAddon()
			term.loadAddon(fitAddon)
			term.open(containerRef.current)
			fitAddon.fit()
			term.focus()

			if (disposed) {
				term.dispose()
				return
			}

			// ── Open WS only after terminal is mounted ───────────
			setStatus('connecting')
			ws = eden.ws.terminal.subscribe()

			ws.on('open', () => {
				if (disposed || !term) return
				setStatus('connected')
				ws!.send({
					type: 'resize',
					cols: term.cols,
					rows: term.rows
				})
			})

			ws.on('close', () => {
				if (!disposed) setStatus('disconnected')
			})

			ws.subscribe(event => {
				term?.write(event.data)
			})

			term.onData(data => {
				ws!.send({ type: 'input', data })
			})

			term.onResize(({ cols, rows }) => {
				ws!.send({ type: 'resize', cols, rows })
			})

			// ── Mouse wheel → SGR mouse sequences ────────────────
			// ghostty-web scrolls its own scrollback on wheel events
			// but doesn't forward them as mouse escape sequences to
			// the PTY app. We capture in the capture phase (before
			// ghostty-web sees it) and send them manually.
			let lastWheel = 0
			let scrollStart = 0
			wheelHandler = (e: WheelEvent) => {
				if (!term) return
				e.preventDefault()
				e.stopPropagation()

				const now = performance.now()
				if (now - lastWheel < 50) return
				lastWheel = now

				// Reset scroll start after 300ms pause
				if (now - scrollStart > 300) scrollStart = now

				// Accel kicks in after 400ms of sustained scrolling
				const elapsed = now - scrollStart
				const lines =
					elapsed < 400
						? 1
						: Math.min(
								1 + Math.floor((elapsed - 400) / 200),
								5
							)

				const seq = wheelToMouseSequences(e, term)
				if (seq)
					ws!.send({
						type: 'input',
						data: seq.repeat(lines)
					})
			}
			containerRef.current.addEventListener(
				'wheel',
				wheelHandler,
				{ passive: false, capture: true }
			)

			// ── Click-to-focus ───────────────────────────────────
			clickHandler = () => term?.focus()
			containerRef.current.addEventListener(
				'mousedown',
				clickHandler
			)

			observer = new ResizeObserver(() => fitAddon?.fit())
			observer.observe(containerRef.current)
		}

		setup()

		return () => {
			disposed = true
			if (containerRef.current) {
				if (wheelHandler) {
					containerRef.current.removeEventListener(
						'wheel',
						wheelHandler,
						{ capture: true }
					)
				}
				if (clickHandler) {
					containerRef.current.removeEventListener(
						'mousedown',
						clickHandler
					)
				}
			}
			observer?.disconnect()
			ws?.close()
			term?.dispose()
		}
	}, [])

	return (
		<div className="h-screen w-screen bg-[#0a0a0a] relative overflow-hidden">
			{status !== 'connected' && (
				<div
					className={`absolute top-4 right-4 z-10 px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur-sm border ${
						status === 'loading' || status === 'connecting'
							? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
							: 'bg-red-500/10 text-red-400 border-red-500/20'
					}`}
				>
					{status === 'loading'
						? 'Loading terminal…'
						: status === 'connecting'
							? 'Connecting…'
							: 'Disconnected'}
				</div>
			)}
			<div ref={containerRef} className="w-full h-full" />
		</div>
	)
}
