import { useEffect, type RefObject } from 'react'
import type { Terminal as GhosttyTerminal } from 'ghostty-web'
import { eden } from '@/lib/eden'
import {
	darkTermTheme,
	lightTermTheme,
	extractOSC11,
	wheelToMouseSequences
} from '../utils'

type TerminalWS = ReturnType<
	typeof eden.ws.terminal.subscribe
>

// ── Keyboard & paste handlers (registered before term.open()) ────────────

function createKeydownHandler(
	getWS: () => TerminalWS | null
): (e: KeyboardEvent) => void {
	return (e: KeyboardEvent) => {
		if (e.key === 'Enter' && e.shiftKey) {
			e.preventDefault()
			e.stopImmediatePropagation()
			getWS()?.send({
				type: 'input',
				data: '\x1b[13;2u'
			})
			return
		}
		if (e.key === 'v' && (e.metaKey || e.ctrlKey)) {
			e.stopImmediatePropagation()
		}
	}
}

function createPasteHandler(
	getWS: () => TerminalWS | null
): (e: ClipboardEvent) => void {
	return (e: ClipboardEvent) => {
		e.preventDefault()
		e.stopImmediatePropagation()
		const text = e.clipboardData?.getData('text/plain')
		if (!text) return
		getWS()?.send({
			type: 'input',
			data: `\x1b[200~${text}\x1b[201~`
		})
	}
}

// ── Mouse wheel → SGR mouse sequences ───────────────────────────────────

function createWheelHandler(
	getTerm: () => GhosttyTerminal | null,
	getWS: () => TerminalWS | null
): (e: WheelEvent) => void {
	let lastWheel = 0
	let scrollStart = 0

	return (e: WheelEvent) => {
		const term = getTerm()
		if (!term) return
		e.preventDefault()
		e.stopPropagation()

		const now = performance.now()
		if (now - lastWheel < 50) return
		lastWheel = now

		if (now - scrollStart > 300) scrollStart = now
		const elapsed = now - scrollStart
		const lines =
			elapsed < 400
				? 1
				: Math.min(1 + Math.floor((elapsed - 400) / 200), 5)

		const seq = wheelToMouseSequences(e, term)
		if (seq)
			getWS()?.send({
				type: 'input',
				data: seq.repeat(lines)
			})
	}
}

// ── Clipboard overlay ───────────────────────────────────────────────────

function createClipboardOverlay(
	container: HTMLDivElement
): HTMLDivElement {
	const clipDiv = document.createElement('div')
	clipDiv.contentEditable = 'true'
	clipDiv.style.cssText =
		'position:absolute;top:0;left:0;width:100%;height:100%;' +
		'opacity:0;z-index:10;overflow:hidden;cursor:text;' +
		'caret-color:transparent;outline:none;'
	clipDiv.setAttribute('aria-hidden', 'true')
	container.style.position = 'relative'
	container.appendChild(clipDiv)
	clipDiv.addEventListener('keydown', e =>
		e.preventDefault()
	)
	return clipDiv
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useTerminal(
	containerRef: RefObject<HTMLDivElement | null>
) {
	useEffect(() => {
		let term: GhosttyTerminal | null = null
		let ws: TerminalWS | null = null
		let observer: ResizeObserver | null = null
		let wheelHandler: ((e: WheelEvent) => void) | null =
			null
		let clickHandler: (() => void) | null = null
		let clipDiv: HTMLDivElement | null = null
		let disposed = false
		const container = containerRef.current

		const getWS = () => ws
		const getTerm = () => term

		const keydownHandler = createKeydownHandler(getWS)
		const pasteHandler = createPasteHandler(getWS)

		function applyTermTheme(bgColor: string) {
			if (!term || !container) return
			const bg = bgColor.toLowerCase()
			const theme =
				bg === lightTermTheme.background
					? lightTermTheme
					: darkTermTheme
			term.options.theme = theme
			container.style.backgroundColor = theme.background
		}

		function connectWS() {
			if (disposed || !term) return
			term.write('\x1b[2J\x1b[H')

			const newWS = eden.ws.terminal.subscribe()
			ws = newWS

			newWS.on('open', () => {
				if (disposed || !term) return
				newWS.send({
					type: 'resize',
					cols: term.cols,
					rows: term.rows
				})
			})

			newWS.on('close', () => {
				if (disposed) return
				setTimeout(() => connectWS(), 500)
			})

			let pendingOutput = ''
			let rafId = 0
			newWS.subscribe(event => {
				if (!term) return
				const { cleaned, bgColor } = extractOSC11(
					event.data
				)
				if (bgColor) applyTermTheme(bgColor)
				if (!cleaned) return
				pendingOutput += cleaned
				if (rafId) return
				rafId = requestAnimationFrame(() => {
					if (term && pendingOutput)
						term.write(pendingOutput)
					pendingOutput = ''
					rafId = 0
				})
			})
		}

		async function setup() {
			if (!container || disposed) return

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
				theme: darkTermTheme
			})

			const fitAddon = new FitAddon()
			term.loadAddon(fitAddon)

			// Register BEFORE term.open() so they fire before ghostty-web's capture handlers
			document.addEventListener('keydown', keydownHandler, {
				capture: true
			})
			document.addEventListener('paste', pasteHandler, {
				capture: true
			})

			term.open(container)
			fitAddon.fit()
			term.focus()

			clipDiv = createClipboardOverlay(container)

			if (disposed) {
				term.dispose()
				return
			}

			term.onData(data => ws?.send({ type: 'input', data }))
			term.onResize(({ cols, rows }) =>
				ws?.send({ type: 'resize', cols, rows })
			)

			wheelHandler = createWheelHandler(getTerm, getWS)
			container.addEventListener('wheel', wheelHandler, {
				passive: false,
				capture: true
			})

			clickHandler = () => clipDiv?.focus()
			container.addEventListener('mousedown', clickHandler)

			observer = new ResizeObserver(() => fitAddon.fit())
			observer.observe(container)

			connectWS()
		}

		setup()

		return () => {
			disposed = true
			if (wheelHandler)
				container?.removeEventListener(
					'wheel',
					wheelHandler,
					{ capture: true }
				)
			if (clickHandler)
				container?.removeEventListener(
					'mousedown',
					clickHandler
				)
			document.removeEventListener(
				'keydown',
				keydownHandler,
				{ capture: true }
			)
			document.removeEventListener('paste', pasteHandler, {
				capture: true
			})
			clipDiv?.remove()
			observer?.disconnect()
			ws?.close()
			term?.dispose()
		}
	}, [containerRef])
}
