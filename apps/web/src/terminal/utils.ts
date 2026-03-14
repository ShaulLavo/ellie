import type { Terminal as GhosttyTerminal } from 'ghostty-web'

// ── Terminal themes ──────────────────────────────────────────

export const darkTermTheme = {
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

export const lightTermTheme = {
	background: '#f5f5f4',
	foreground: '#1c1917',
	cursor: '#1c1917',
	cursorAccent: '#f5f5f4',
	selectionBackground: '#d6d3d1',
	black: '#1c1917',
	red: '#dc2626',
	green: '#16a34a',
	yellow: '#ca8a04',
	blue: '#2563eb',
	magenta: '#9333ea',
	cyan: '#0891b2',
	white: '#e7e5e4',
	brightBlack: '#78716c',
	brightRed: '#ef4444',
	brightGreen: '#22c55e',
	brightYellow: '#eab308',
	brightBlue: '#3b82f6',
	brightMagenta: '#a855f7',
	brightCyan: '#06b6d4',
	brightWhite: '#fafaf9'
}

// OSC 11 pattern: \x1b]11;#rrggbb\x07  (BEL terminator)
// or              \x1b]11;#rrggbb\x1b\\ (ST terminator)
/* eslint-disable no-control-regex -- intentional terminal escape sequences */
const OSC11_RE = new RegExp(
	'\\x1b\\]11;(#[0-9a-fA-F]{6})(?:\\x07|\\x1b\\\\)',
	'g'
)
/* eslint-enable no-control-regex */

/**
 * Scan data for OSC 11 (set background color) escape sequences.
 * Returns the cleaned data (OSC stripped) and the last bg color found, if any.
 */
export function extractOSC11(data: string): {
	cleaned: string
	bgColor: string | null
} {
	let bgColor: string | null = null
	const cleaned = data.replace(
		OSC11_RE,
		(_match, color) => {
			bgColor = color
			return ''
		}
	)
	return { cleaned, bgColor }
}

/**
 * Convert a wheel event into SGR mouse escape sequences.
 * The TUI enables SGR extended mouse mode (\x1b[?1006h),
 * which expects: \x1b[<button;col;rowM
 *   button 64 = scroll up, 65 = scroll down
 */
export function wheelToMouseSequences(
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
	return `\x1b[<${button};${col};${row}M`
}
