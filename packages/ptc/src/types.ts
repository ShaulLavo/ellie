/** JSON Schema object describing tool input parameters. */
export interface JsonSchema {
	type?: string
	properties?: Record<string, JsonSchema>
	required?: string[]
	description?: string
	items?: JsonSchema
	enum?: unknown[]
	[key: string]: unknown
}

/** Generic tool definition independent of any specific tool framework. */
export interface ToolDefinition {
	name: string
	description: string
	inputSchema: JsonSchema
}

/** Result returned by a tool invocation. */
export interface ToolResult {
	[key: string]: unknown
}

/** Client that resolves tool calls by name + args. */
export interface ToolClient {
	callTool(
		name: string,
		args: Record<string, unknown>
	): Promise<ToolResult>
}

/** Options controlling PTC execution limits. */
export interface ExecutePTCOptions {
	/** Kill child after this many ms. @default 30_000 */
	timeoutMs?: number
	/** Max tool round-trips before aborting. @default 64 */
	maxToolCalls?: number
	/** Max bytes of non-protocol stdout to keep. @default 262_144 */
	maxOutputBytes?: number
	/** Max bytes of stderr to capture for diagnostics. @default 65_536 */
	captureStderrBytes?: number
	/** Directory for temp script files. @default os.tmpdir() */
	tempDir?: string
}

export const PTC_DEFAULTS = {
	timeoutMs: 30_000,
	maxToolCalls: 64,
	maxOutputBytes: 262_144,
	captureStderrBytes: 65_536
} as const

export type PTCErrorCode =
	| 'TIMEOUT'
	| 'SCRIPT_EXIT'
	| 'SCRIPT_RUNTIME'
	| 'OUTPUT_LIMIT'
	| 'SPAWN_FAILED'
	| 'PROTOCOL_ERROR'

export class PTCExecutionError extends Error {
	readonly code: PTCErrorCode
	readonly exitCode?: number
	readonly stderrSnippet?: string
	readonly toolCallsUsed?: number
	readonly outputBytes?: number

	constructor(
		code: PTCErrorCode,
		message: string,
		opts?: {
			exitCode?: number
			stderrSnippet?: string
			toolCallsUsed?: number
			outputBytes?: number
			cause?: unknown
		}
	) {
		super(message, { cause: opts?.cause })
		this.name = 'PTCExecutionError'
		this.code = code
		this.exitCode = opts?.exitCode
		this.stderrSnippet = opts?.stderrSnippet
		this.toolCallsUsed = opts?.toolCallsUsed
		this.outputBytes = opts?.outputBytes
	}
}
