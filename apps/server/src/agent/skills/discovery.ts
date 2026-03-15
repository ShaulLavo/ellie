import { join, dirname, basename } from 'node:path'
import {
	readFileSync,
	readdirSync,
	statSync,
	realpathSync
} from 'node:fs'
import { homedir } from 'node:os'
import { parseFrontmatter } from './frontmatter'
import { validateMetadata } from './validator'
import type {
	Skill,
	SkillFrontmatter,
	SkillDiagnostic,
	LoadSkillsResult
} from './types'

function loadSkillFromFile(
	filePath: string,
	baseDir: string,
	source: 'global' | 'project'
): {
	skill: Skill | null
	diagnostics: SkillDiagnostic[]
} {
	const diagnostics: SkillDiagnostic[] = []

	let content: string
	try {
		content = readFileSync(filePath, 'utf-8')
	} catch {
		diagnostics.push({
			type: 'error',
			message: `Failed to read ${filePath}`,
			path: filePath
		})
		return { skill: null, diagnostics }
	}

	const metadata =
		parseFrontmatter<Record<string, unknown>>(content)
	if (!metadata) {
		diagnostics.push({
			type: 'error',
			message: 'Missing or invalid YAML frontmatter',
			path: filePath
		})
		return { skill: null, diagnostics }
	}

	const dirName = basename(dirname(filePath))
	const errors = validateMetadata(metadata, dirName)

	if (errors.length > 0) {
		for (const msg of errors) {
			diagnostics.push({
				type: 'error',
				message: msg,
				path: filePath
			})
		}
		return { skill: null, diagnostics }
	}

	// Safe to cast — validation guarantees required fields
	const fm = metadata as unknown as SkillFrontmatter

	return {
		skill: {
			name: fm.name,
			description: fm.description,
			filePath,
			baseDir,
			source,
			license: fm.license,
			compatibility: fm.compatibility,
			metadata: fm.metadata,
			allowedTools: fm['allowed-tools'],
			disableModelInvocation: fm.disableModelInvocation
		},
		diagnostics
	}
}

function loadSkillsFromDir(
	dir: string,
	source: 'global' | 'project'
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skills: Skill[] = []
	const diagnostics: SkillDiagnostic[] = []

	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return { skills, diagnostics }
	}

	for (const entry of entries) {
		const skillDir = join(dir, entry)
		try {
			if (!statSync(skillDir).isDirectory()) continue
		} catch {
			continue
		}

		const skillFile = join(skillDir, 'SKILL.md')
		try {
			statSync(skillFile)
		} catch {
			continue
		}

		const result = loadSkillFromFile(skillFile, dir, source)
		diagnostics.push(...result.diagnostics)
		if (result.skill) {
			skills.push(result.skill)
		}
	}

	return { skills, diagnostics }
}

export interface LoadSkillsOptions {
	cwd?: string
}

export function loadSkills(
	options?: LoadSkillsOptions
): LoadSkillsResult {
	const cwd = options?.cwd ?? process.cwd()
	const allSkills: Skill[] = []
	const allDiagnostics: SkillDiagnostic[] = []
	const seenPaths = new Set<string>()
	const seenNames = new Map<string, string>()

	const dirs: Array<{
		path: string
		source: 'global' | 'project'
	}> = [
		{
			path: join(homedir(), '.agents', 'skills'),
			source: 'global'
		},
		{
			path: join(cwd, '.agents', 'skills'),
			source: 'project'
		},
		{
			path: join(cwd, '.claude', 'skills'),
			source: 'project'
		}
	]

	for (const { path, source } of dirs) {
		const { skills, diagnostics } = loadSkillsFromDir(
			path,
			source
		)
		allDiagnostics.push(...diagnostics)

		for (const skill of skills) {
			// Deduplicate by realpath
			let realPath: string
			try {
				realPath = realpathSync(skill.filePath)
			} catch {
				realPath = skill.filePath
			}
			if (seenPaths.has(realPath)) continue
			seenPaths.add(realPath)

			// Warn on name collision, keep first found
			const existing = seenNames.get(skill.name)
			if (existing) {
				allDiagnostics.push({
					type: 'warning',
					message: `Duplicate skill name "${skill.name}" — keeping ${existing}, skipping ${skill.filePath}`,
					path: skill.filePath
				})
				continue
			}
			seenNames.set(skill.name, skill.filePath)

			allSkills.push(skill)
		}
	}

	return { skills: allSkills, diagnostics: allDiagnostics }
}
