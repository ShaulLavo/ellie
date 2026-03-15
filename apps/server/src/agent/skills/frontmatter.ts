import { parse as parseYaml } from 'yaml'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

export function parseFrontmatter<T>(
	content: string
): T | null {
	const match = content.match(FRONTMATTER_RE)
	if (!match) return null
	try {
		return parseYaml(match[1]) as T
	} catch {
		return null
	}
}

export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_RE, '').trimStart()
}
