import { describe, expect, test } from 'bun:test'
import type { BlobSink } from '@ellie/trace'
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
})
