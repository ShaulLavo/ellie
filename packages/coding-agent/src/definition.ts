/**
 * Coding agent definition — stub shell.
 *
 * Registered for agentType='coding' but deliberately fails with a
 * stable "not implemented yet" error if invoked. No memory, no channels,
 * no tools, no meaningful prompt.
 */

import type {
	AgentDefinition,
	AgentContextSnapshot,
	AgentHostServices,
	NormalizedUserInput
} from '@ellie/agent'

export class CodingAgentNotImplementedError extends Error {
	constructor() {
		super('Coding agent is not implemented yet')
		this.name = 'CodingAgentNotImplementedError'
	}
}

export function createCodingAgentDefinition(): AgentDefinition {
	return {
		agentType: 'coding',

		normalizeUserInput(
			input: NormalizedUserInput,
			_services: AgentHostServices
		): NormalizedUserInput {
			// Pass-through — no transformation
			return input
		},

		selectSkills() {
			// Empty skill selection
			return []
		},

		async buildContext(
			_branchId: string,
			_normalizedInput: NormalizedUserInput,
			_services: AgentHostServices
		): Promise<AgentContextSnapshot> {
			throw new CodingAgentNotImplementedError()
		},

		selectTools() {
			// Empty tool set
			return []
		}
	}
}
