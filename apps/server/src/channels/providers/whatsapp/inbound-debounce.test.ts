import { describe, test, expect } from 'bun:test'
import { createInboundDebouncer } from './inbound-debounce'
import type { ChannelInboundMessage } from '../../core/types'

function makeMsg(
	overrides: Partial<ChannelInboundMessage> = {}
): ChannelInboundMessage {
	return {
		channelId: 'whatsapp',
		accountId: 'acc1',
		conversationId: 'conv1',
		senderId: 'sender1',
		text: 'hello',
		timestamp: Date.now(),
		...overrides
	}
}

describe('createInboundDebouncer', () => {
	test('immediate passthrough when debounceMs = 0', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 0,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		const msg = makeMsg({ text: 'immediate' })
		debouncer.enqueue('key1', msg)

		// Should flush immediately (async)
		await Bun.sleep(10)
		expect(flushed.length).toBe(1)
		expect(flushed[0].text).toBe('immediate')
		debouncer.dispose()
	})

	test('batches messages within debounce window', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 100,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		debouncer.enqueue('key1', makeMsg({ text: 'one' }))
		debouncer.enqueue('key1', makeMsg({ text: 'two' }))
		debouncer.enqueue('key1', makeMsg({ text: 'three' }))

		// Should not have flushed yet
		expect(flushed.length).toBe(0)

		// Wait for debounce window to expire
		await Bun.sleep(150)
		expect(flushed.length).toBe(1)
		expect(flushed[0].text).toBe('one\ntwo\nthree')
		debouncer.dispose()
	})

	test('resets timer on new message', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 100,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		debouncer.enqueue('key1', makeMsg({ text: 'first' }))
		await Bun.sleep(60)
		// Add another message before the 100ms window expires
		debouncer.enqueue('key1', makeMsg({ text: 'second' }))
		await Bun.sleep(60)
		// The original timer should have been reset, so nothing flushed yet
		expect(flushed.length).toBe(0)

		await Bun.sleep(60)
		expect(flushed.length).toBe(1)
		expect(flushed[0].text).toBe('first\nsecond')
		debouncer.dispose()
	})

	test('isolates by key', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 100,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		debouncer.enqueue(
			'key1',
			makeMsg({ text: 'a1', senderId: 's1' })
		)
		debouncer.enqueue(
			'key2',
			makeMsg({ text: 'b1', senderId: 's2' })
		)

		await Bun.sleep(150)
		expect(flushed.length).toBe(2)
		const texts = flushed.map(m => m.text).sort()
		expect(texts).toEqual(['a1', 'b1'])
		debouncer.dispose()
	})

	test('uses last message metadata', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 50,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		debouncer.enqueue(
			'key1',
			makeMsg({
				text: 'old',
				senderName: 'OldName',
				externalId: 'id1'
			})
		)
		debouncer.enqueue(
			'key1',
			makeMsg({
				text: 'new',
				senderName: 'NewName',
				externalId: 'id2'
			})
		)

		await Bun.sleep(100)
		expect(flushed.length).toBe(1)
		expect(flushed[0].senderName).toBe('NewName')
		expect(flushed[0].externalId).toBe('id2')
		debouncer.dispose()
	})

	test('dispose cancels pending timers', async () => {
		const flushed: ChannelInboundMessage[] = []
		const debouncer = createInboundDebouncer({
			debounceMs: 100,
			onFlush: async msg => {
				flushed.push(msg)
			}
		})

		debouncer.enqueue('key1', makeMsg({ text: 'pending' }))
		debouncer.dispose()

		await Bun.sleep(150)
		expect(flushed.length).toBe(0)
	})
})
