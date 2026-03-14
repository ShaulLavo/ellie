import { describe, expect, test } from 'bun:test'
import type { StoredChatMessage } from '@/chat/types'
import { projectTimeline } from './project-timeline'

function createMessage(
	overrides: Partial<StoredChatMessage>
): StoredChatMessage {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		timestamp:
			overrides.timestamp ??
			new Date('2026-03-14T10:00:00.000Z').toISOString(),
		text: overrides.text ?? '',
		parts: overrides.parts ?? [],
		seq: overrides.seq ?? 0,
		sender: overrides.sender,
		isStreaming: overrides.isStreaming,
		streamGroupId: overrides.streamGroupId,
		thinking: overrides.thinking,
		runId: overrides.runId,
		eventType: overrides.eventType,
		parentMessageId: overrides.parentMessageId
	}
}

describe('projectTimeline', () => {
	test('renders memory_retain as a between-turn system item', () => {
		const runId = 'run-1'
		const assistantId = 'assistant-1'
		const retainId = 'retain-1'
		const messages: StoredChatMessage[] = [
			createMessage({
				id: 'user-1',
				seq: 1,
				eventType: 'user_message',
				sender: 'user'
			}),
			createMessage({
				id: assistantId,
				seq: 2,
				runId,
				eventType: 'assistant_message',
				sender: 'agent',
				parts: [{ type: 'text', text: 'answer' }],
				text: 'answer'
			}),
			createMessage({
				id: retainId,
				seq: 3,
				eventType: 'memory_retain',
				sender: 'memory',
				parts: [
					{
						type: 'memory-retain',
						factsStored: 1,
						facts: ['stored fact']
					}
				]
			}),
			createMessage({
				id: 'user-2',
				seq: 4,
				eventType: 'user_message',
				sender: 'user'
			})
		]

		const { timeline } = projectTimeline(messages)

		expect(timeline).toHaveLength(4)
		expect(timeline[1]).toMatchObject({
			type: 'assistant-turn',
			runId
		})
		if (timeline[1]?.type !== 'assistant-turn') {
			throw new Error('Expected assistant turn at index 1')
		}
		expect(timeline[1].steps).toHaveLength(0)
		expect(timeline[2]).toMatchObject({
			type: 'system',
			message: { id: retainId }
		})
	})
})
