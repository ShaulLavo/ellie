import { describe, test, expect } from 'bun:test'
import {
	recordGroupHistory,
	buildContextText,
	type GroupHistoryEntry
} from './group-history'

describe('recordGroupHistory', () => {
	test('records an entry', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'Alice', body: 'hello' },
			50
		)
		expect(histories.get('group1@g.us')).toEqual([
			{ sender: 'Alice', body: 'hello' }
		])
	})

	test('appends multiple entries', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'Alice', body: 'hello' },
			50
		)
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'Bob', body: 'hi' },
			50
		)
		expect(histories.get('group1@g.us')).toHaveLength(2)
	})

	test('respects historyLimit — evicts oldest', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'A', body: 'msg1' },
			2
		)
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'B', body: 'msg2' },
			2
		)
		recordGroupHistory(
			histories,
			'group1@g.us',
			{ sender: 'C', body: 'msg3' },
			2
		)

		const entries = histories.get('group1@g.us')!
		expect(entries).toHaveLength(2)
		expect(entries[0].sender).toBe('B')
		expect(entries[1].sender).toBe('C')
	})

	test('LRU eviction removes oldest group key', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()

		// Fill up to MAX_GROUP_HISTORY_KEYS (200) + 1
		for (let i = 0; i <= 200; i++) {
			recordGroupHistory(
				histories,
				`group${i}@g.us`,
				{ sender: 'test', body: 'msg' },
				50
			)
		}

		// Should have evicted the oldest (group0) since we now have 201
		expect(histories.size).toBeLessThanOrEqual(201)
		// The first group (group0) should be evicted
		expect(histories.has('group0@g.us')).toBe(false)
		// The latest should exist
		expect(histories.has('group200@g.us')).toBe(true)
	})
})

describe('buildContextText', () => {
	test('returns current text when no history', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		expect(
			buildContextText(
				histories,
				'group1@g.us',
				'hello bot'
			)
		).toBe('hello bot')
	})

	test('returns current text when history is empty array', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		histories.set('group1@g.us', [])
		expect(
			buildContextText(
				histories,
				'group1@g.us',
				'hello bot'
			)
		).toBe('hello bot')
	})

	test('prepends history context to current message', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		histories.set('group1@g.us', [
			{ sender: 'Alice', body: 'what time is it?' },
			{ sender: 'Bob', body: "it's 3pm" }
		])

		const result = buildContextText(
			histories,
			'group1@g.us',
			'@bot what did they say?'
		)

		expect(result).toBe(
			[
				'[Chat messages since your last reply - for context]',
				"Alice: what time is it?\nBob: it's 3pm",
				'',
				'[Current message]',
				'@bot what did they say?'
			].join('\n')
		)
	})

	test('clears history after consuming', () => {
		const histories = new Map<string, GroupHistoryEntry[]>()
		histories.set('group1@g.us', [
			{ sender: 'Alice', body: 'msg' }
		])

		buildContextText(histories, 'group1@g.us', '@bot hello')

		// History should be cleared (empty array, not deleted)
		expect(histories.get('group1@g.us')).toEqual([])
	})
})
