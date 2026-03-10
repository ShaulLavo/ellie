import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobSink } from '@ellie/trace'
import {
	TraceRecorder,
	createRootScope
} from '@ellie/trace'
import { createToolRegistry } from './capability-registry'

describe('createToolRegistry', () => {
	test('registers generate_image when blobSink is available', () => {
		const registry = createToolRegistry({
			workspaceDir: '/tmp',
			dataDir: '/tmp',
			getSessionId: () => 'session-1',
			getRunId: () => 'run-1',
			blobSink: {
				write: async () => ({
					uploadId: 'upload-1',
					url: '/api/uploads-rpc/upload-1/content',
					storagePath: 'uploads/upload-1',
					mimeType: 'image/png',
					sizeBytes: 1,
					ohash: 'hash',
					role: 'generated_image'
				})
			} as unknown as BlobSink
		})

		expect(registry.all.map(tool => tool.name)).toContain(
			'generate_image'
		)
	})

	test('omits generate_image when blobSink is unavailable', () => {
		const registry = createToolRegistry({
			workspaceDir: '/tmp',
			dataDir: '/tmp',
			getSessionId: () => 'session-1',
			getRunId: () => 'run-1'
		})

		expect(
			registry.all.map(tool => tool.name)
		).not.toContain('generate_image')
	})

	test('keeps generate_image when direct tools are trace-wrapped', () => {
		const traceDir = mkdtempSync(
			join(tmpdir(), 'ellie-capability-registry-')
		)
		const recorder = new TraceRecorder(traceDir)
		const registry = createToolRegistry({
			workspaceDir: '/tmp',
			dataDir: '/tmp',
			getSessionId: () => 'session-1',
			getRunId: () => 'run-1',
			traceRecorder: recorder,
			blobSink: {
				write: async () => ({
					uploadId: 'upload-1',
					url: '/api/uploads-rpc/upload-1/content',
					storagePath: 'uploads/upload-1',
					mimeType: 'image/png',
					sizeBytes: 1,
					ohash: 'hash',
					role: 'generated_image'
				})
			} as unknown as BlobSink,
			getTraceScope: () =>
				createRootScope({
					traceKind: 'chat',
					sessionId: 'session-1',
					runId: 'run-1'
				})
		})

		expect(registry.all.map(tool => tool.name)).toContain(
			'generate_image'
		)
	})
})
