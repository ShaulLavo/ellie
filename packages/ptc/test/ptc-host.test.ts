import { describe, expect, test } from 'bun:test'
import { executePTC } from '../src/ptc-host'
import { PTCExecutionError } from '../src/types'
import type {
	ToolClient,
	ToolDefinition,
	ToolResult
} from '../src/types'

// ── Helpers ─────────────────────────────────────────────────────────

function echoClient(): ToolClient {
	return {
		async callTool(
			name: string,
			args: Record<string, unknown>
		): Promise<ToolResult> {
			return { echoed: true, tool: name, args }
		}
	}
}

const echoTool: ToolDefinition = {
	name: 'echo',
	description: 'Echoes args back',
	inputSchema: {
		type: 'object',
		properties: { msg: { type: 'string' } },
		required: ['msg']
	}
}

const addTool: ToolDefinition = {
	name: 'add',
	description: 'Add two numbers',
	inputSchema: {
		type: 'object',
		properties: {
			a: { type: 'number' },
			b: { type: 'number' }
		},
		required: ['a', 'b']
	}
}

function addClient(): ToolClient {
	return {
		async callTool(
			_name: string,
			args: Record<string, unknown>
		): Promise<ToolResult> {
			return {
				sum: (args.a as number) + (args.b as number)
			}
		}
	}
}

// ── Tests ───────────────────────────────────────────────────────────

describe('executePTC', () => {
	test('single tool call round-trip returns final output', async () => {
		const code = `
const result = await echo({ msg: "hello" });
console.log(JSON.stringify(result));
`
		const output = await executePTC(
			code,
			[echoTool],
			echoClient()
		)
		const parsed = JSON.parse(output.trim())
		expect(parsed.echoed).toBe(true)
		expect(parsed.args.msg).toBe('hello')
	})

	test('multiple sequential tool calls', async () => {
		const code = `
const r1 = await add({ a: 1, b: 2 });
const r2 = await add({ a: 10, b: 20 });
console.log(JSON.stringify({ first: r1, second: r2 }));
`
		const output = await executePTC(
			code,
			[addTool],
			addClient()
		)
		const parsed = JSON.parse(output.trim())
		expect(parsed.first.sum).toBe(3)
		expect(parsed.second.sum).toBe(30)
	})

	test('concurrent Promise.all calls resolve correctly by id', async () => {
		const code = `
const [r1, r2, r3] = await Promise.all([
	add({ a: 1, b: 1 }),
	add({ a: 2, b: 2 }),
	add({ a: 3, b: 3 }),
]);
console.log(JSON.stringify({ r1, r2, r3 }));
`
		const output = await executePTC(
			code,
			[addTool],
			addClient()
		)
		const parsed = JSON.parse(output.trim())
		expect(parsed.r1.sum).toBe(2)
		expect(parsed.r2.sum).toBe(4)
		expect(parsed.r3.sum).toBe(6)
	})

	test('undefined tool symbol throws ReferenceError in child', async () => {
		const code = `
try {
	await nonexistent_tool({ x: 1 });
} catch (e) {
	console.log("caught: " + e.message);
}
`
		// nonexistent_tool is not in the SDK → ReferenceError in the child
		const tools: ToolDefinition[] = []
		const output = await executePTC(
			code,
			tools,
			echoClient()
		)
		expect(output).toContain('caught')
	})

	test('tool throw propagates as error to child', async () => {
		const throwClient: ToolClient = {
			async callTool(): Promise<ToolResult> {
				throw new Error('deliberate failure')
			}
		}

		const code = `
try {
	const r = await echo({ msg: "test" });
	console.log("unexpected: " + JSON.stringify(r));
} catch (e) {
	console.log("tool_error: " + e.message);
}
`
		const output = await executePTC(
			code,
			[echoTool],
			throwClient
		)
		expect(output).toContain(
			'tool_error: deliberate failure'
		)
	})

	test('timeout kills child and throws TIMEOUT', async () => {
		const code = `
await new Promise(r => setTimeout(r, 60000));
console.log("should not reach here");
`
		try {
			await executePTC(code, [], echoClient(), {
				timeoutMs: 500
			})
			expect.unreachable('should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(PTCExecutionError)
			expect((e as PTCExecutionError).code).toBe('TIMEOUT')
		}
	})

	test('max tool calls limit enforced', async () => {
		const code = `
for (let i = 0; i < 100; i++) {
	await echo({ msg: "call " + i });
}
console.log("done");
`
		try {
			await executePTC(code, [echoTool], echoClient(), {
				maxToolCalls: 3,
				timeoutMs: 10_000
			})
			expect.unreachable('should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(PTCExecutionError)
			const err = e as PTCExecutionError
			expect(err.code).toBe('SCRIPT_RUNTIME')
			expect(err.message).toContain('max tool calls')
		}
	})

	test('max output bytes limit enforced', async () => {
		const code = `
for (let i = 0; i < 10000; i++) {
	console.log("x".repeat(1000));
}
`
		try {
			await executePTC(code, [], echoClient(), {
				maxOutputBytes: 1024,
				timeoutMs: 10_000
			})
			expect.unreachable('should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(PTCExecutionError)
			expect((e as PTCExecutionError).code).toBe(
				'OUTPUT_LIMIT'
			)
		}
	})

	test('non-protocol JSON lines are preserved as final output', async () => {
		const code = `
console.log(JSON.stringify({ user: "data" }));
console.log("plain text line");
`
		const output = await executePTC(code, [], echoClient())
		expect(output).toContain('{"user":"data"}')
		expect(output).toContain('plain text line')
	})

	test('non-zero exit throws with stderr snippet', async () => {
		const code = `
throw new Error("intentional crash");
`
		try {
			await executePTC(code, [], echoClient())
			expect.unreachable('should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(PTCExecutionError)
			const err = e as PTCExecutionError
			expect(err.code).toBe('SCRIPT_EXIT')
			expect(err.exitCode).toBe(1)
			expect(err.stderrSnippet).toContain(
				'intentional crash'
			)
		}
	})

	test('child inherits host env vars', async () => {
		const sentinel = `PTC_TEST_SENTINEL_${Date.now()}`
		process.env[sentinel] = 'visible'
		try {
			const code = `
const val = process.env["${sentinel}"] ?? "undefined";
console.log("SENTINEL=" + val);
`
			const output = await executePTC(
				code,
				[],
				echoClient()
			)
			expect(output.trim()).toBe('SENTINEL=visible')
		} finally {
			delete process.env[sentinel]
		}
	})

	test('no-arg tool call does not deadlock', async () => {
		const noArgTool: ToolDefinition = {
			name: 'ping',
			description: 'Ping with no arguments',
			inputSchema: { type: 'object' }
		}
		const pingClient: ToolClient = {
			async callTool(): Promise<ToolResult> {
				return { pong: true }
			}
		}

		const code = `
const result = await ping();
console.log(JSON.stringify(result));
`
		const output = await executePTC(
			code,
			[noArgTool],
			pingClient,
			{ timeoutMs: 5_000 }
		)
		const parsed = JSON.parse(output.trim())
		expect(parsed.pong).toBe(true)
	})

	test('non-identifier tool name works end-to-end', async () => {
		const dashTool: ToolDefinition = {
			name: 'send-email',
			description: 'Send email',
			inputSchema: {
				type: 'object',
				properties: { to: { type: 'string' } },
				required: ['to']
			}
		}
		const client: ToolClient = {
			async callTool(
				_name: string,
				args: Record<string, unknown>
			): Promise<ToolResult> {
				return { sent: true, to: args.to }
			}
		}

		// Use the safe variable name generated for non-identifier tools
		const code = `
const result = await __tool_send_email({ to: "test@example.com" });
console.log(JSON.stringify(result));
`
		const output = await executePTC(
			code,
			[dashTool],
			client,
			{ timeoutMs: 5_000 }
		)
		const parsed = JSON.parse(output.trim())
		expect(parsed.sent).toBe(true)
		expect(parsed.to).toBe('test@example.com')
	})

	test('plain output with no tool calls', async () => {
		const code = `
console.log("hello world");
`
		const output = await executePTC(code, [], echoClient())
		expect(output.trim()).toBe('hello world')
	})
})
