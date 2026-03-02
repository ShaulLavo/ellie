import type { JsonSchema, ToolDefinition } from './types'

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

/** Build a TS type literal for a tool's inputSchema (top-level object). */
function buildArgsType(schema: JsonSchema): string {
	const props = schema.properties
	if (!props || Object.keys(props).length === 0) return '{}'

	const required = new Set(schema.required ?? [])
	const fields = Object.entries(props).map(
		([key, propSchema]) => {
			const opt = required.has(key) ? '' : '?'
			const tsType = jsonSchemaTypeToTS(propSchema)
			return `\t${key}${opt}: ${tsType}`
		}
	)
	return `{\n${fields.join('\n')}\n}`
}

/** Build JSDoc block for a tool wrapper function. */
function buildJSDoc(tool: ToolDefinition): string {
	const lines: string[] = ['/**']
	lines.push(` * ${tool.description}`)
	lines.push(` *`)
	lines.push(
		` * Input schema: ${JSON.stringify(tool.inputSchema)}`
	)
	lines.push(` */`)
	return lines.join('\n')
}

/**
 * Generate a self-contained TypeScript SDK string that the child process
 * evaluates. It provides one async wrapper per tool that communicates
 * with the host over JSONL stdio.
 */
export function generateSDK(
	tools: ToolDefinition[]
): string {
	const parts: string[] = []

	// ── infrastructure ──────────────────────────────────────────────
	parts.push(`// PTC child SDK – generated, do not edit
const __pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let __callCounter = 0;

// Background stdin reader – resolves pending tool-result promises.
const __reader = Bun.stdin.stream().getReader();
(async () => {
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await __reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\\n')) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.__ptc_result__ && msg.id) {
						const p = __pending.get(msg.id);
						if (p) {
							__pending.delete(msg.id);
							if (msg.error !== undefined) {
								p.reject(new Error(String(msg.error)));
							} else {
								p.resolve(msg.result);
							}
						}
					}
				} catch { /* ignore malformed host lines */ }
			}
		}
	} catch { /* stdin closed */ }
})();

async function __callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	const id = String(++__callCounter);
	const msg = JSON.stringify({ __ptc_call__: true, id, tool: name, args });
	await Bun.write(Bun.stdout, msg + '\\n');
	return new Promise<unknown>((resolve, reject) => {
		__pending.set(id, { resolve, reject });
	});
}
`)

	// ── per-tool wrappers ───────────────────────────────────────────
	for (const tool of tools) {
		const argsType = buildArgsType(tool.inputSchema)
		const jsdoc = buildJSDoc(tool)

		parts.push(`${jsdoc}
async function ${tool.name}(args: ${argsType}): Promise<unknown> {
	return __callTool(${JSON.stringify(tool.name)}, args as Record<string, unknown>);
}
`)
	}

	return parts.join('\n')
}
