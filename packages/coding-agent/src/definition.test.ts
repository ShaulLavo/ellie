import { describe, test, expect } from 'bun:test'
import type { AgentHostServices } from '@ellie/agent'
import {
	createCodingAgentDefinition,
	CodingAgentNotImplementedError
} from './definition'

const mockServices = {} as AgentHostServices

describe('createCodingAgentDefinition', () => {
	test('returns definition with agentType coding', () => {
		const def = createCodingAgentDefinition()
		expect(def.agentType).toBe('coding')
	})

	test('normalizeUserInput passes input through unchanged', () => {
		const def = createCodingAgentDefinition()
		const input = {
			text: 'hello world',
			rawText: 'hello world'
		}
		const result = def.normalizeUserInput(
			input,
			mockServices
		)
		expect(result).toBe(input)
	})

	test('selectSkills returns empty array', () => {
		const def = createCodingAgentDefinition()
		const result = def.selectSkills!([], mockServices)
		expect(result).toEqual([])
	})

	test('selectTools returns empty array', () => {
		const def = createCodingAgentDefinition()
		const result = def.selectTools!(mockServices)
		expect(result).toEqual([])
	})

	test('buildContext throws CodingAgentNotImplementedError', async () => {
		const def = createCodingAgentDefinition()
		try {
			await def.buildContext(
				'branch-1',
				{ text: 'test', rawText: 'test' },
				mockServices
			)
			expect(true).toBe(false) // Should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(
				CodingAgentNotImplementedError
			)
			expect((err as Error).message).toBe(
				'Coding agent is not implemented yet'
			)
			expect((err as Error).name).toBe(
				'CodingAgentNotImplementedError'
			)
		}
	})

	test('has no hooks', () => {
		const def = createCodingAgentDefinition()
		expect(def.hooks).toBeUndefined()
	})

	test('has no onBind/onUnbind', () => {
		const def = createCodingAgentDefinition()
		expect(def.onBind).toBeUndefined()
		expect(def.onUnbind).toBeUndefined()
	})
})

describe('CodingAgentNotImplementedError', () => {
	test('is an instance of Error', () => {
		const err = new CodingAgentNotImplementedError()
		expect(err).toBeInstanceOf(Error)
	})

	test('has stable name and message', () => {
		const err = new CodingAgentNotImplementedError()
		expect(err.name).toBe('CodingAgentNotImplementedError')
		expect(err.message).toBe(
			'Coding agent is not implemented yet'
		)
	})
})
