export interface Skill {
	name: string
	description: string
	filePath: string
	baseDir: string
	source: 'global' | 'project'
	license?: string
	compatibility?: string
	metadata?: Record<string, string>
	allowedTools?: string
	disableModelInvocation?: boolean
}

export interface SkillFrontmatter {
	name: string
	description: string
	license?: string
	compatibility?: string
	metadata?: Record<string, string>
	'allowed-tools'?: string
	disableModelInvocation?: boolean
}

export interface SkillDiagnostic {
	type: 'warning' | 'error'
	message: string
	path: string
}

export interface LoadSkillsResult {
	skills: Skill[]
	diagnostics: SkillDiagnostic[]
}
