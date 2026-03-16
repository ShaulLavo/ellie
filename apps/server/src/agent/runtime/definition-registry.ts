/**
 * AgentDefinitionRegistry — maps agentType strings to AgentDefinition
 * factory functions.
 */

import type { AgentDefinition } from '@ellie/agent'

export class AgentDefinitionRegistry {
	private readonly definitions = new Map<
		string,
		AgentDefinition
	>()

	register(definition: AgentDefinition): void {
		if (this.definitions.has(definition.agentType)) {
			throw new Error(
				`AgentDefinition already registered for type '${definition.agentType}'`
			)
		}
		this.definitions.set(definition.agentType, definition)
	}

	get(agentType: string): AgentDefinition | undefined {
		return this.definitions.get(agentType)
	}

	require(agentType: string): AgentDefinition {
		const def = this.definitions.get(agentType)
		if (!def) {
			throw new Error(
				`No AgentDefinition registered for type '${agentType}'`
			)
		}
		return def
	}

	has(agentType: string): boolean {
		return this.definitions.has(agentType)
	}

	registeredTypes(): string[] {
		return [...this.definitions.keys()]
	}
}
