/**
 * Assistant agent definition — implements AgentDefinition for the
 * Ellie assistant personality.
 *
 * Composes the core Agent through the shared definition contract.
 * No subclass of Agent exists.
 */

import type {
	AgentDefinition,
	AgentContextSnapshot,
	AgentHostServices,
	NormalizedUserInput,
	AgentTool
} from '@ellie/agent'
import type { Skill } from '@ellie/agent/skills'
import {
	loadSkills,
	formatSkillsForPrompt,
	expandSkillCommand
} from '@ellie/agent/skills'
import type { EventStore } from '@ellie/db'
import type { Hindsight } from '@ellie/hindsight'
import { buildSystemPrompt } from './system-prompt'
import { MemoryOrchestrator } from './memory-orchestrator'
import { createToolRegistry } from './tools/capability-registry'

export interface AssistantAgentConfig {
	hindsight: Hindsight
	eventStore: EventStore
}

export interface AssistantAgentState {
	baseSystemPrompt: string
	skills: Skill[]
	memory: MemoryOrchestrator
	tools: AgentTool[]
}

/** Assistant uses all discovered skills — no filtering. */
function selectAssistantSkills(
	allSkills: Skill[]
): Skill[] {
	return allSkills
}

export function createAssistantAgentDefinition(
	config: AssistantAgentConfig
): AgentDefinition {
	let state: AssistantAgentState | null = null

	function ensureState(
		services: AgentHostServices
	): AssistantAgentState {
		if (state) return state

		const basePrompt = buildSystemPrompt(
			services.workspaceDir
		)

		// Discovery + per-agent selection
		const { skills: allSkills, diagnostics } = loadSkills()
		for (const d of diagnostics) {
			console.warn(
				`[skills] ${d.type}: ${d.message} (${d.path})`
			)
		}
		// selectSkills filters — assistant uses all discovered skills
		const skills = selectAssistantSkills(allSkills)
		if (skills.length > 0) {
			console.log(
				`[skills] loaded ${skills.length} skill(s)`
			)
		}

		const skillsBlock = formatSkillsForPrompt(skills)
		const prompt = skillsBlock
			? basePrompt + '\n\n---\n\n' + skillsBlock
			: basePrompt

		const memory = new MemoryOrchestrator({
			hindsight: config.hindsight,
			eventStore: config.eventStore,
			workspaceDir: services.workspaceDir
		})

		const registry = createToolRegistry({
			workspaceDir: services.workspaceDir,
			dataDir: services.dataDir,
			getBranchId: () => null,
			getRunId: () => null,
			traceRecorder: services.traceRecorder,
			blobSink: services.blobSink,
			getTraceScope: services.getTraceScope,
			eventStore: services.eventStore as
				| EventStore
				| undefined,
			credentialsPath: services.credentialsPath
		})

		state = {
			baseSystemPrompt: prompt,
			skills,
			memory,
			tools: registry.all
		}

		return state
	}

	return {
		agentType: 'assistant',

		normalizeUserInput(
			input: NormalizedUserInput,
			services: AgentHostServices
		): NormalizedUserInput {
			const s = ensureState(services)
			const expanded = expandSkillCommand(
				input.text,
				s.skills
			)
			return expanded !== input.text
				? { ...input, text: expanded }
				: input
		},

		selectSkills(
			allSkills: Skill[],
			_services: AgentHostServices
		): Skill[] {
			return selectAssistantSkills(allSkills)
		},

		buildPromptSections(
			services: AgentHostServices
		): string[] {
			const s = ensureState(services)
			return [s.baseSystemPrompt]
		},

		async buildContext(
			branchId: string,
			_normalizedInput: NormalizedUserInput,
			services: AgentHostServices
		): Promise<AgentContextSnapshot> {
			const s = ensureState(services)
			const messages = services.loadHistory(branchId)

			return {
				systemPrompt: s.baseSystemPrompt,
				messages,
				tools: s.tools,
				thinkingLevel: 'low'
			}
		},

		selectTools(services: AgentHostServices): AgentTool[] {
			const s = ensureState(services)
			return s.tools
		},

		hooks: {
			async beforeRun(
				_branchId,
				_runId,
				context,
				services
			) {
				const s = ensureState(services)

				// Run memory recall
				try {
					const result = await s.memory.recall(
						context.messages
							.filter(m => m.role === 'user')
							.at(-1)
							?.content.filter(
								(c): c is { type: 'text'; text: string } =>
									c.type === 'text'
							)
							.map(c => c.text)
							.join(' ') ?? ''
					)

					if (result?.contextBlock) {
						return {
							...context,
							systemPrompt:
								context.systemPrompt +
								'\n\n' +
								result.contextBlock
						}
					}
				} catch (err) {
					console.warn(
						'[assistant-agent] recall failed:',
						err
					)
				}

				return context
			},

			async afterRun(branchId, _runId, services) {
				const s = ensureState(services)
				try {
					await s.memory.evaluateRetain(branchId)
				} catch (err) {
					console.warn(
						'[assistant-agent] retain failed:',
						err
					)
				}
			}
		}
	}
}
