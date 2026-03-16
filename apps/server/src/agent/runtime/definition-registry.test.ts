import { describe, test, expect } from 'bun:test'
import type { AgentDefinition } from '@ellie/agent'
import { AgentDefinitionRegistry } from './definition-registry'

function makeStubDefinition(
	agentType: string
): AgentDefinition {
	return {
		agentType,
		normalizeUserInput(input) {
			return input
		},
		async buildContext() {
			return {
				systemPrompt: '',
				messages: [],
				tools: []
			}
		}
	}
}

describe('AgentDefinitionRegistry', () => {
	test('register and get a definition', () => {
		const registry = new AgentDefinitionRegistry()
		const def = makeStubDefinition('assistant')
		registry.register(def)
		expect(registry.get('assistant')).toBe(def)
	})

	test('get returns undefined for unregistered type', () => {
		const registry = new AgentDefinitionRegistry()
		expect(registry.get('unknown')).toBeUndefined()
	})

	test('require returns definition for registered type', () => {
		const registry = new AgentDefinitionRegistry()
		const def = makeStubDefinition('coding')
		registry.register(def)
		expect(registry.require('coding')).toBe(def)
	})

	test('require throws for unregistered type', () => {
		const registry = new AgentDefinitionRegistry()
		expect(() => registry.require('missing')).toThrow(
			"No AgentDefinition registered for type 'missing'"
		)
	})

	test('has returns true for registered type', () => {
		const registry = new AgentDefinitionRegistry()
		registry.register(makeStubDefinition('assistant'))
		expect(registry.has('assistant')).toBe(true)
	})

	test('has returns false for unregistered type', () => {
		const registry = new AgentDefinitionRegistry()
		expect(registry.has('unknown')).toBe(false)
	})

	test('register throws on duplicate agentType', () => {
		const registry = new AgentDefinitionRegistry()
		registry.register(makeStubDefinition('assistant'))
		expect(() =>
			registry.register(makeStubDefinition('assistant'))
		).toThrow(
			"AgentDefinition already registered for type 'assistant'"
		)
	})

	test('registeredTypes returns all registered types', () => {
		const registry = new AgentDefinitionRegistry()
		registry.register(makeStubDefinition('assistant'))
		registry.register(makeStubDefinition('coding'))
		const types = registry.registeredTypes()
		expect(types).toContain('assistant')
		expect(types).toContain('coding')
		expect(types).toHaveLength(2)
	})

	test('supports multiple distinct registrations', () => {
		const registry = new AgentDefinitionRegistry()
		const assistantDef = makeStubDefinition('assistant')
		const codingDef = makeStubDefinition('coding')
		registry.register(assistantDef)
		registry.register(codingDef)
		expect(registry.get('assistant')).toBe(assistantDef)
		expect(registry.get('coding')).toBe(codingDef)
	})
})
