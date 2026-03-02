import { join } from 'node:path'
import type { ToolDefinition } from './types'
import { generateSDK } from './sdk-generator'

const WRAPPER_PATH = join(
	import.meta.dirname,
	'child-wrapper.ts'
)

let _wrapperCache: string | null = null

/** Read the child-wrapper.ts template (cached after first read). */
async function readWrapper(): Promise<string> {
	if (_wrapperCache) return _wrapperCache
	_wrapperCache = await Bun.file(WRAPPER_PATH).text()
	return _wrapperCache
}

/**
 * Build a complete self-contained script string that:
 * 1. Includes the generated SDK preamble (tool wrappers + stdin reader).
 * 2. Wraps the agent code in an async IIFE.
 * 3. Adds an auto-termination guard (process.exit) to prevent Bun hangs
 *    caused by the persistent stdin-reader task.
 */
export async function buildScript(
	agentCode: string,
	tools: ToolDefinition[]
): Promise<string> {
	const [sdk, wrapper] = await Promise.all([
		generateSDK(tools),
		readWrapper()
	])

	const indented = indentBlock(agentCode, 2)
	const script = wrapper.replace(
		'// {{AGENT_CODE}}',
		indented
	)

	return `${sdk}\n${script}`
}

/** Indent every line of a code block by the given number of tabs. */
function indentBlock(code: string, tabs: number): string {
	const prefix = '\t'.repeat(tabs)
	return code
		.split('\n')
		.map(line => (line.trim() ? `${prefix}${line}` : line))
		.join('\n')
}
