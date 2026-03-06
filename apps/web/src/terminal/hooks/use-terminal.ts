import { useEffect, type RefObject } from 'react'
import type {
	Terminal as GhosttyTerminal,
	FitAddon
} from 'ghostty-web'
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

export function useTerminal(
	containerRef: RefObject<HTMLDivElement | null>
) {
	useEffect(() => {
		let term: GhosttyTerminal | null = null
		let fitAddon: FitAddon | null = null
		let ws: TerminalWS | null = null
		let observer: ResizeObserver | null = null
		let wheelHandler: ((e: WheelEvent) => void) | null =
			null
		let clickHandler: (() => void) | null = null
		let keydownHandler:
			| ((e: KeyboardEvent) => void)
			| null = null
		let clipDiv: HTMLDivElement | null = null
		let pasteHandler:
			| ((e: ClipboardEvent) => void)
			| null = null
		let disposed = false
		const container = containerRef.current

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

			// Clear screen + cursor home so the fresh TUI starts clean.
			// Avoid \x1bc (RIS) — it resets the terminal color theme
			// back to defaults, wiping the custom palette.
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
				console.log(
					'[terminal] ws closed, reconnecting in 500ms'
				)
				setTimeout(() => connectWS(), 500)
			})

			// Batch terminal output into animation frames so a
			// flood of small WS messages (e.g. during paste) gets
			// coalesced into a single term.write + canvas redraw.
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

			fitAddon = new FitAddon()
			term.loadAddon(fitAddon)

			// ── Register BEFORE term.open() ─────────────────────
			// ghostty-web installs its own document-level capture
			// listeners in open(). Since capture handlers on the same
			// element fire in registration order, we must register
			// first so we intercept before ghostty-web.

			keydownHandler = (e: KeyboardEvent) => {
				if (e.key === 'Enter' && e.shiftKey) {
					e.preventDefault()
					e.stopImmediatePropagation()
					ws?.send({
						type: 'input',
						data: '\x1b[13;2u'
					})
					return
				}
				// Stop ghostty-web from handling Cmd/Ctrl+V so
				// paste only fires once (via our document paste
				// handler). Don't preventDefault — the browser
				// still needs to generate the paste event.
				if (e.key === 'v' && (e.metaKey || e.ctrlKey)) {
					e.stopImmediatePropagation()
					return
				}
			}

			// ── Paste handler (document capture phase) ──────────
			// Intercept the paste event before ghostty-web can see
			// it. Read clipboard data and forward to PTY as
			// bracketed paste. stopImmediatePropagation ensures
			// ghostty-web's own paste handler never fires.
			pasteHandler = (e: ClipboardEvent) => {
				e.preventDefault()
				e.stopImmediatePropagation()
				const text =
					e.clipboardData?.getData('text/plain')
				if (!text || !ws) return
				ws.send({
					type: 'input',
					data: `\x1b[200~${text}\x1b[201~`
				})
			}

			// Register both BEFORE term.open() so they fire
			// before ghostty-web's capture handlers.
			document.addEventListener(
				'keydown',
				keydownHandler,
				{ capture: true }
			)
			document.addEventListener('paste', pasteHandler, {
				capture: true
			})

			term.open(container)
			fitAddon.fit()
			term.focus()

			// ── Contenteditable overlay ──────────────────────────
			// The browser only generates paste events when an
			// editable element is focused. This invisible div
			// serves as the focus target; actual paste handling
			// happens in the document capture handler above.
			clipDiv = document.createElement('div')
			clipDiv.contentEditable = 'true'
			clipDiv.style.cssText =
				'position:absolute;top:0;left:0;width:100%;height:100%;' +
				'opacity:0;z-index:10;overflow:hidden;cursor:text;' +
				'caret-color:transparent;outline:none;'
			clipDiv.setAttribute('aria-hidden', 'true')
			container.style.position = 'relative'
			container.appendChild(clipDiv)

			// Prevent the contenteditable from handling any keyboard
			// input — it exists only as a paste focus target.
			clipDiv.addEventListener('keydown', e => {
				e.preventDefault()
			})

			if (disposed) {
				term.dispose()
				return
			}

			// Register once — these read the current `ws` via closure.
			term.onData(data => {
				ws?.send({ type: 'input', data })
			})

			term.onResize(({ cols, rows }) => {
				ws?.send({ type: 'resize', cols, rows })
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
								1 +
									Math.floor(
										(elapsed - 400) / 200
									),
								5
							)

				const seq = wheelToMouseSequences(e, term)
				if (seq)
					ws?.send({
						type: 'input',
						data: seq.repeat(lines)
					})
			}
			container.addEventListener('wheel', wheelHandler, {
				passive: false,
				capture: true
			})

			// ── Click-to-focus ───────────────────────────────────
			clickHandler = () => clipDiv?.focus()
			container.addEventListener(
				'mousedown',
				clickHandler
			)

			observer = new ResizeObserver(() => fitAddon?.fit())
			observer.observe(container)

			// ── Connect WS (spawns PTY on server) ────────────────
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
			if (keydownHandler)
				document.removeEventListener(
					'keydown',
					keydownHandler,
					{ capture: true }
				)
			if (pasteHandler)
				document.removeEventListener(
					'paste',
					pasteHandler,
					{ capture: true }
				)
			clipDiv?.remove()
			observer?.disconnect()
			ws?.close()
			term?.dispose()
		}
	}, [])
}
