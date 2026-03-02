import type { ToolDefinition } from './types'
import { generateSDK } from './sdk-generator'

/**
 * Build a complete self-contained script string that:
 * 1. Includes the generated SDK preamble (tool wrappers + stdin reader).
 * 2. Wraps the agent code in an async IIFE.
 * 3. Adds an auto-termination guard (process.exit) to prevent Bun hangs
 *    caused by the persistent stdin-reader task.
 */
export function buildScript(
	agentCode: string,
	tools: ToolDefinition[]
): string {
	const sdk = generateSDK(tools)

	return `${sdk}
// ── agent code (wrapped) ────────────────────────────────────────
(async () => {
	try {
${indentBlock(agentCode, 2)}
	} catch (__err) {
		const msg = __err instanceof Error ? __err.message : String(__err);
		console.error(\`[ptc] agent error: \${msg}\`);
		process.exit(1);
	}
	process.exit(0);
})();
`
}

/** Indent every line of a code block by the given number of tabs. */
function indentBlock(code: string, tabs: number): string {
	const prefix = '\t'.repeat(tabs)
	return code
		.split('\n')
		.map(line => (line.trim() ? `${prefix}${line}` : line))
		.join('\n')
}
