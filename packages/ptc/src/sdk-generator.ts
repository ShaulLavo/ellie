import { join } from 'node:path'
import type { JsonSchema, ToolDefinition } from './types'

const RUNTIME_PATH = join(
	import.meta.dirname,
	'child-runtime.ts'
)

let _runtimeCache: string | null = null

/** Read the child-runtime.ts file (cached after first read). */
async function readRuntime(): Promise<string> {
	if (_runtimeCache) return _runtimeCache
	_runtimeCache = await Bun.file(RUNTIME_PATH).text()
	return _runtimeCache
}

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

/** Check if a string is a valid JS identifier. */
function isValidIdentifier(name: string): boolean {
	return VALID_IDENTIFIER.test(name)
}

/** Escape a string for safe embedding inside a JSDoc comment block. */
function escapeJSDoc(text: string): string {
	return text.replace(/\*\//g, '*\\/')
}

/**
 * Map a JSON Schema type string to a basic TypeScript type annotation.
 * Falls back to `unknown` for anything exotic.
 */
function jsonSchemaTypeToTS(schema: JsonSchema): string {
	if (!schema.type) return 'unknown'
	switch (schema.type) {
		case 'string':
			return 'string'
		case 'number':
		case 'integer':
			return 'number'
		case 'boolean':
			return 'boolean'
		case 'array':
			if (schema.items)
				return `${jsonSchemaTypeToTS(schema.items)}[]`
			return 'unknown[]'
		case 'object':
			return 'Record<string, unknown>'
		default:
			return 'unknown'
	}
}

/** Quote a property key if it's not a valid identifier. */
function safeKey(key: string): string {
	return isValidIdentifier(key) ? key : JSON.stringify(key)
}

/** Build a TS type literal for a tool's inputSchema (top-level object). */
function buildArgsType(schema: JsonSchema): string {
	const props = schema.properties
	if (!props || Object.keys(props).length === 0) return '{}'

	const required = new Set(schema.required ?? [])
	const fields = Object.entries(props).map(
		([key, propSchema]) => {
			const opt = required.has(key) ? '' : '?'
			const tsType = jsonSchemaTypeToTS(propSchema)
			return `\t${safeKey(key)}${opt}: ${tsType}`
		}
	)
	return `{\n${fields.join('\n')}\n}`
}

/** Build JSDoc block for a tool wrapper function. */
function buildJSDoc(tool: ToolDefinition): string {
	const lines: string[] = ['/**']
	lines.push(` * ${escapeJSDoc(tool.description)}`)
	lines.push(` *`)
	lines.push(
		` * Input schema: ${escapeJSDoc(JSON.stringify(tool.inputSchema))}`
	)
	lines.push(` */`)
	return lines.join('\n')
}

/** Generate per-tool async wrapper functions. */
function generateToolWrappers(
	tools: ToolDefinition[]
): string {
	const parts: string[] = []

	for (const tool of tools) {
		const argsType = buildArgsType(tool.inputSchema)
		const jsdoc = buildJSDoc(tool)
		const nameStr = JSON.stringify(tool.name)

		if (isValidIdentifier(tool.name)) {
			parts.push(`${jsdoc}
async function ${tool.name}(args: ${argsType} = {} as any): Promise<unknown> {
	return __callTool(${nameStr}, args ?? {});
}
`)
		} else {
			// Non-identifier names use a const with bracket notation
			parts.push(`${jsdoc}
const ${nameToSafeVar(tool.name)} = async (args: ${argsType} = {} as any): Promise<unknown> => {
	return __callTool(${nameStr}, args ?? {});
};
`)
		}
	}

	return parts.join('\n')
}

/** Convert a non-identifier tool name to a safe variable name. */
function nameToSafeVar(name: string): string {
	return '__tool_' + name.replace(/[^a-zA-Z0-9_$]/g, '_')
}

/**
 * Generate a self-contained TypeScript SDK string that the child process
 * evaluates. It provides one async wrapper per tool that communicates
 * with the host over JSONL stdio.
 */
export async function generateSDK(
	tools: ToolDefinition[]
): Promise<string> {
	const runtime = await readRuntime()
	const wrappers = generateToolWrappers(tools)
	return `${runtime}\n${wrappers}`
}
