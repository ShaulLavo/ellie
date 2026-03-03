import { join } from 'node:path'
import type { ToolDefinition } from './types'

const RUNTIME_PATH = join(
	import.meta.dirname,
	'child-runtime.ts'
)
const WRAPPER_PATH = join(
	import.meta.dirname,
	'child-wrapper.ts'
)

let _runtimeCache: string | null = null
let _wrapperCache: string | null = null

async function readRuntime(): Promise<string> {
	if (_runtimeCache) return _runtimeCache
	_runtimeCache = await Bun.file(RUNTIME_PATH).text()
	return _runtimeCache
}

async function readWrapper(): Promise<string> {
	if (_wrapperCache) return _wrapperCache
	_wrapperCache = await Bun.file(WRAPPER_PATH).text()
	return _wrapperCache
}

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function nameToSafeVar(name: string): string {
	return '__tool_' + name.replace(/[^a-zA-Z0-9_$]/g, '_')
}

function generateToolWrappers(
	tools: ToolDefinition[]
): string {
	const parts: string[] = []
	for (const tool of tools) {
		const nameStr = JSON.stringify(tool.name)
		if (VALID_IDENTIFIER.test(tool.name)) {
			parts.push(
				`async function ${tool.name}(args) { return __callTool(${nameStr}, args ?? {}) }`
			)
		} else {
			parts.push(
				`const ${nameToSafeVar(tool.name)} = async (args) => __callTool(${nameStr}, args ?? {})`
			)
		}
	}
	return parts.join('\n')
}

/**
 * Build a complete self-contained script string that:
 * 1. Includes the runtime preamble (IPC handler + __callTool).
 * 2. Includes simple tool wrapper functions.
 * 3. Wraps the user code in an async IIFE with auto-termination.
 */
export async function buildScript(
	userCode: string,
	tools: ToolDefinition[]
): Promise<string> {
	const [runtime, wrapper] = await Promise.all([
		readRuntime(),
		readWrapper()
	])

	const wrappers = generateToolWrappers(tools)
	const indented = indentBlock(userCode, 2)
	const script = wrapper.replace(
		'// {{AGENT_CODE}}',
		indented
	)

	return `${runtime}\n${wrappers}\n${script}`
}

/** Indent every line of a code block by the given number of tabs. */
function indentBlock(code: string, tabs: number): string {
	const prefix = '\t'.repeat(tabs)
	return code
		.split('\n')
		.map(line => (line.trim() ? `${prefix}${line}` : line))
		.join('\n')
}
