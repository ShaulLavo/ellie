/**
 * Inbound message debouncer for WhatsApp.
 * Batches rapid consecutive messages from the same sender within a configurable
 * window, then flushes them as a single concatenated message.
 *
 * When debounceMs is 0, messages pass through immediately (no buffering).
 */

import type { ChannelInboundMessage } from '../../core/types'

type PendingEntry = {
	messages: ChannelInboundMessage[]
	timer: ReturnType<typeof setTimeout>
}

export type InboundDebouncer = {
	/** Enqueue a message. If debounceMs is 0, flushes immediately. */
	enqueue: (key: string, msg: ChannelInboundMessage) => void
	/** Cancel all pending timers (for shutdown). */
	dispose: () => void
}

/**
 * Create an inbound debouncer that batches messages by key.
 *
 * @param debounceMs - Window in ms. 0 = disabled (immediate passthrough).
 * @param onFlush - Called with the combined message when the window expires.
 */
export function createInboundDebouncer(params: {
	debounceMs: number
	onFlush: (msg: ChannelInboundMessage) => Promise<void>
}): InboundDebouncer {
	const { debounceMs, onFlush } = params
	const pending = new Map<string, PendingEntry>()

	function flush(key: string): void {
		const entry = pending.get(key)
		if (!entry) return
		pending.delete(key)

		const messages = entry.messages
		if (messages.length === 0) return

		const last = messages[messages.length - 1]
		const combined: ChannelInboundMessage = {
			...last,
			text: messages.map(m => m.text).join('\n')
		}

		onFlush(combined).catch(err => {
			console.error(
				`[whatsapp] Debounce flush failed for ${key}:`,
				err
			)
		})
	}

	return {
		enqueue(key: string, msg: ChannelInboundMessage): void {
			// Disabled — immediate passthrough
			if (debounceMs <= 0) {
				onFlush(msg).catch(err => {
					console.error(
						`[whatsapp] Ingest failed for ${key}:`,
						err
					)
				})
				return
			}

			const existing = pending.get(key)
			if (existing) {
				clearTimeout(existing.timer)
				existing.messages.push(msg)
				existing.timer = setTimeout(
					() => flush(key),
					debounceMs
				)
			} else {
				const timer = setTimeout(
					() => flush(key),
					debounceMs
				)
				pending.set(key, { messages: [msg], timer })
			}
		},

		dispose(): void {
			for (const [, entry] of pending) {
				clearTimeout(entry.timer)
			}
			pending.clear()
		}
	}
}
