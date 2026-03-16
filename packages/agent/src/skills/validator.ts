import { basename } from 'node:path'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { parseFrontmatter } from './frontmatter'

const MAX_SKILL_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_COMPATIBILITY_LENGTH = 500

const ALLOWED_FIELDS = new Set([
	'name',
	'description',
	'license',
	'allowed-tools',
	'metadata',
	'compatibility',
	'disableModelInvocation'
])

function validateName(
	name: unknown,
	dirName?: string
): string[] {
	const errors: string[] = []

	if (!name || typeof name !== 'string' || !name.trim()) {
		errors.push("Field 'name' must be a non-empty string")
		return errors
	}

	const normalized = name.normalize('NFKC').trim()

	if (normalized.length > MAX_SKILL_NAME_LENGTH) {
		errors.push(
			`Skill name '${normalized}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${normalized.length} chars)`
		)
	}

	if (normalized !== normalized.toLowerCase()) {
		errors.push(
			`Skill name '${normalized}' must be lowercase`
		)
	}

	if (
		normalized.startsWith('-') ||
		normalized.endsWith('-')
	) {
		errors.push(
			'Skill name cannot start or end with a hyphen'
		)
	}

	if (normalized.includes('--')) {
		errors.push(
			'Skill name cannot contain consecutive hyphens'
		)
	}

	for (const ch of normalized) {
		if (!isAlphanumeric(ch) && ch !== '-') {
			errors.push(
				`Skill name '${normalized}' contains invalid characters. Only letters, digits, and hyphens are allowed.`
			)
			break
		}
	}

	if (dirName) {
		const normalizedDir = dirName.normalize('NFKC')
		if (normalizedDir !== normalized) {
			errors.push(
				`Directory name '${dirName}' must match skill name '${normalized}'`
			)
		}
	}

	return errors
}

function isAlphanumeric(ch: string): boolean {
	return /^[\p{L}\p{N}]$/u.test(ch)
}

function validateDescription(
	description: unknown
): string[] {
	if (
		!description ||
		typeof description !== 'string' ||
		!description.trim()
	) {
		return [
			"Field 'description' must be a non-empty string"
		]
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return [
			`Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${description.length} chars)`
		]
	}

	return []
}

function validateCompatibility(
	compatibility: unknown
): string[] {
	if (typeof compatibility !== 'string') {
		return ["Field 'compatibility' must be a string"]
	}

	if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
		return [
			`Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} character limit (${compatibility.length} chars)`
		]
	}

	return []
}

function validateAllowedFields(
	metadata: Record<string, unknown>
): string[] {
	const extra = Object.keys(metadata).filter(
		k => !ALLOWED_FIELDS.has(k)
	)
	if (extra.length === 0) return []

	return [
		`Unexpected fields in frontmatter: ${extra.sort().join(', ')}. Only ${[...ALLOWED_FIELDS].sort().join(', ')} are allowed.`
	]
}

export function validateMetadata(
	metadata: Record<string, unknown>,
	dirName?: string
): string[] {
	const errors: string[] = []

	errors.push(...validateAllowedFields(metadata))

	if (!('name' in metadata)) {
		errors.push(
			'Missing required field in frontmatter: name'
		)
	} else {
		errors.push(...validateName(metadata.name, dirName))
	}

	if (!('description' in metadata)) {
		errors.push(
			'Missing required field in frontmatter: description'
		)
	} else {
		errors.push(
			...validateDescription(metadata.description)
		)
	}

	if ('compatibility' in metadata) {
		errors.push(
			...validateCompatibility(metadata.compatibility)
		)
	}

	return errors
}

export function validate(skillDir: string): string[] {
	if (!existsSync(skillDir)) {
		return [`Path does not exist: ${skillDir}`]
	}

	if (!statSync(skillDir).isDirectory()) {
		return [`Not a directory: ${skillDir}`]
	}

	const skillMd = `${skillDir}/SKILL.md`
	if (!existsSync(skillMd)) {
		return ['Missing required file: SKILL.md']
	}

	let content: string
	try {
		content = readFileSync(skillMd, 'utf-8')
	} catch (err) {
		return [
			`Failed to read SKILL.md: ${err instanceof Error ? err.message : String(err)}`
		]
	}

	const metadata =
		parseFrontmatter<Record<string, unknown>>(content)
	if (!metadata) {
		return ['Missing or invalid YAML frontmatter']
	}

	return validateMetadata(metadata, basename(skillDir))
}
