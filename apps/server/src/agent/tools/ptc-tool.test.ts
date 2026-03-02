import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import { createPtcTool } from './ptc-tool'

// ── Helpers ─────────────────────────────────────────────────────────────

function makeEchoTool(): AgentTool {
	return {
		name: 'echo',
		description: 'Echo back the input',
		label: 'Echoing',
		parameters: v.object({
			msg: v.string()
		}),
		execute: async (
			_callId,
			params
		): Promise<AgentToolResult> => ({
			content: [
				{
					type: 'text',
					text: `echo: ${(params as { msg: string }).msg}`
				}
			],
			details: { echoed: true }
		})
	}
}

function makeFailTool(): AgentTool {
	return {
		name: 'fail_tool',
		description: 'Always throws an error',
		label: 'Failing',
		parameters: v.object({
			reason: v.string()
		}),
		execute: async (
			_callId,
			params
		): Promise<AgentToolResult> => {
			throw new Error((params as { reason: string }).reason)
		}
	}
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('createPtcTool', () => {
	test('success: script calls tool and outputs result', async () => {
		const ptcTool = createPtcTool([makeEchoTool()])

		const result = await ptcTool.execute(
			'call-1',
			{
				script: `
const r = await echo({ msg: "hello" });
console.log(JSON.stringify(r));
`
			},
			undefined,
			undefined
		)

		expect(result.details).toEqual({ success: true })
		const text = (
			result.content[0] as { type: 'text'; text: string }
		).text
		expect(text).toContain('echo: hello')
	})

	test('success: plain output with no tool calls', async () => {
		const ptcTool = createPtcTool([])

		const result = await ptcTool.execute(
			'call-2',
			{ script: 'console.log("just text");' },
			undefined,
			undefined
		)

		expect(result.details).toEqual({ success: true })
		const text = (
			result.content[0] as { type: 'text'; text: string }
		).text
		expect(text).toContain('just text')
	})

	test('timeout: returns error details', async () => {
		const ptcTool = createPtcTool([])

		const result = await ptcTool.execute(
			'call-3',
			{
				script:
					'await new Promise(r => setTimeout(r, 60000));',
				timeoutMs: 500
			},
			undefined,
			undefined
		)

		expect(result.details).toEqual(
			expect.objectContaining({ success: false })
		)
		const text = (
			result.content[0] as { type: 'text'; text: string }
		).text
		expect(text).toContain('TIMEOUT')
	})

	test('tool error: surfaces error in output', async () => {
		const ptcTool = createPtcTool([makeFailTool()])

		const result = await ptcTool.execute(
			'call-4',
			{
				script: `
try {
	await fail_tool({ reason: "deliberate" });
} catch (e) {
	console.log("caught: " + e.message);
}
`
			},
			undefined,
			undefined
		)

		expect(result.details).toEqual({ success: true })
		const text = (
			result.content[0] as { type: 'text'; text: string }
		).text
		expect(text).toContain('caught: deliberate')
	})

	test('max tool calls: returns limit error', async () => {
		const ptcTool = createPtcTool([makeEchoTool()])

		const result = await ptcTool.execute(
			'call-5',
			{
				script: `
for (let i = 0; i < 100; i++) {
	await echo({ msg: "call " + i });
}
`,
				maxToolCalls: 2,
				timeoutMs: 10_000
			},
			undefined,
			undefined
		)

		expect(result.details).toEqual(
			expect.objectContaining({ success: false })
		)
		const text = (
			result.content[0] as { type: 'text'; text: string }
		).text
		expect(text).toContain('max tool calls')
	})
})
