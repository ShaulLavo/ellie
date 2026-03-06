import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRootScope } from '../scope'
import { TraceRecorder } from '../recorder'
import { createTracedReplTool } from '../facades/traced-repl'

describe('createTracedReplTool', () => {
	const tempDirs: string[] = []
	const originalWarn = console.warn

	afterEach(() => {
		console.warn = originalWarn
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('falls back to inline output when blob persistence fails', async () => {
		const traceDir = mkdtempSync(
			join(tmpdir(), 'traced-repl-test-')
		)
		tempDirs.push(traceDir)

		console.warn = () => {}

		const recorder = new TraceRecorder(traceDir)
		const rootScope = createRootScope({
			traceKind: 'chat',
			sessionId: 'session-1'
		})
		const outputText = 'x'.repeat(70_000)
		const tool = createTracedReplTool(
			{
				name: 'session_exec',
				description: 'persistent repl',
				parameters: {},
				label: 'running',
				execute: async (
					_toolCallId: string,
					_params: unknown
				) => ({
					content: [{ type: 'text', text: outputText }],
					details: {}
				})
			},
			{
				recorder,
				getParentScope: () => rootScope,
				blobSink: {
					write: async () => {
						throw new Error('blob unavailable')
					}
				}
			}
		)

		await tool.execute('tool-1', {
			code: 'print("hi")'
		})

		const replEnd = recorder
			.readTrace(rootScope.traceId)
			.find(event => event.kind === 'repl.end')

		expect(replEnd).toBeDefined()
		expect(replEnd!.blobRefs).toBeUndefined()
		expect(replEnd!.payload).toMatchObject({
			output: outputText
		})
		expect(
			(replEnd!.payload as Record<string, unknown>)
				.outputPreview
		).toBeUndefined()
	})
})
