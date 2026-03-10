import { describe, test, expect } from 'bun:test'
import { parseVcard } from './vcard'

describe('parseVcard', () => {
	test('returns empty for undefined', () => {
		expect(parseVcard()).toEqual({ phones: [] })
	})

	test('returns empty for empty string', () => {
		expect(parseVcard('')).toEqual({ phones: [] })
	})

	test('extracts FN', () => {
		const vcard = 'BEGIN:VCARD\nFN:John Smith\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('John Smith')
	})

	test('extracts N when FN not present', () => {
		const vcard =
			'BEGIN:VCARD\nN:Smith;John;Michael;;\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe(
			'Smith John Michael'
		)
	})

	test('FN takes precedence over N', () => {
		const vcard =
			'BEGIN:VCARD\nN:Smith;John;;\nFN:Johnny Smith\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('Johnny Smith')
	})

	test('handles N with charset parameter', () => {
		const vcard =
			'BEGIN:VCARD\nN;CHARSET=UTF-8:Smith;John;;\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('Smith John')
	})

	test('extracts single phone', () => {
		const vcard =
			'BEGIN:VCARD\nFN:Test\nTEL:+15551234567\nEND:VCARD'
		expect(parseVcard(vcard).phones).toEqual([
			'+15551234567'
		])
	})

	test('extracts phone with TYPE', () => {
		const vcard =
			'BEGIN:VCARD\nFN:Test\nTEL;TYPE=CELL:+15551234567\nEND:VCARD'
		expect(parseVcard(vcard).phones).toEqual([
			'+15551234567'
		])
	})

	test('extracts multiple phones', () => {
		const vcard =
			'BEGIN:VCARD\nFN:Test\nTEL:+1111\nTEL;TYPE=HOME:+2222\nEND:VCARD'
		expect(parseVcard(vcard).phones).toEqual([
			'+1111',
			'+2222'
		])
	})

	test('handles escaped characters', () => {
		const vcard =
			'BEGIN:VCARD\nFN:John\\, Jr.\nTEL:+1555\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('John, Jr.')
	})

	test('handles line folding (continuation)', () => {
		const vcard =
			'BEGIN:VCARD\nFN:John\n Smith\nTEL:+1555\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('JohnSmith')
	})

	test('handles CRLF line endings', () => {
		const vcard =
			'BEGIN:VCARD\r\nFN:Test Name\r\nTEL:+1555\r\nEND:VCARD'
		expect(parseVcard(vcard).name).toBe('Test Name')
		expect(parseVcard(vcard).phones).toEqual(['+1555'])
	})

	test('handles malformed vCard (no name)', () => {
		const vcard = 'BEGIN:VCARD\nTEL:+1555\nEND:VCARD'
		const result = parseVcard(vcard)
		expect(result.name).toBeUndefined()
		expect(result.phones).toEqual(['+1555'])
	})

	test('handles malformed vCard (no phone)', () => {
		const vcard = 'BEGIN:VCARD\nFN:NoPhone\nEND:VCARD'
		const result = parseVcard(vcard)
		expect(result.name).toBe('NoPhone')
		expect(result.phones).toEqual([])
	})

	test('real-world WhatsApp vCard', () => {
		const vcard = [
			'BEGIN:VCARD',
			'VERSION:3.0',
			'N:Doe;Jane;;;',
			'FN:Jane Doe',
			'TEL;type=CELL;waid=15551234567:+1 555 123 4567',
			'END:VCARD'
		].join('\n')
		const result = parseVcard(vcard)
		expect(result.name).toBe('Jane Doe')
		expect(result.phones).toEqual(['+1 555 123 4567'])
	})
})
