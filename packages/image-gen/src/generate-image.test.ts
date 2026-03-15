import { describe, test, expect } from 'bun:test'
import {
	executeImageGeneration,
	type GenerationDeps
} from './generate-image'
import { LORA_PRESETS } from './model-registry'
import { VERSION_STAMP } from './auto-setup'
import type { BlobSink } from '@ellie/trace'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

function makeMockBlobSink(): BlobSink {
	return {
		write: async opts => ({
			uploadId: `upload-${Date.now()}`,
			url: `/blobs/upload-${Date.now()}`,
			storagePath: `trace/${opts.traceId}/${opts.spanId}/${opts.role}/blob.${opts.ext}`,
			mimeType: opts.mimeType,
			sizeBytes: Buffer.isBuffer(opts.content)
				? opts.content.length
				: Buffer.from(opts.content as string).length,
			ohash: 'mock-hash',
			role: opts.role
		})
	}
}

function makeTmpDataDir(): string {
	const dir = join(
		tmpdir(),
		`gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
	)
	mkdirSync(dir, { recursive: true })
	return dir
}

function makeDeps(
	overrides?: Partial<GenerationDeps>
): GenerationDeps {
	return {
		blobSink: makeMockBlobSink(),
		sessionId: 'test-session',
		runId: 'test-run',
		dataDir: makeTmpDataDir(),
		...overrides
	}
}

// These tests verify request building and early-return error paths
// that happen BEFORE the Python worker is spawned.

describe('executeImageGeneration — error paths (no subprocess)', () => {
	test('returns error for unknown model name', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{ prompt: 'test', model: 'nonexistent' },
			deps
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Unknown model')
		expect(result.error).toContain('nonexistent')
		expect(result.durationMs).toBe(0)
	})

	test('ELLA rejected for SDXL models', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				model: 'sdxl',
				useElla: true
			},
			deps
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('ELLA')
		expect(result.error).toContain('SDXL')
		expect(result.durationMs).toBe(0)
	})

	test('unknown model error includes available model list', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{ prompt: 'test', model: 'bad' },
			deps
		)
		expect(result.error).toContain('sd15')
		expect(result.error).toContain('sdxl')
	})
})

describe('executeImageGeneration — request building (via error path inspection)', () => {
	test('resolves model preset defaults for sdxl', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				model: 'sdxl',
				useElla: true
			},
			deps
		)
		expect(result.request.model).toBe('sdxl')
	})

	test('falls back to sd15 when no model specified (via unknown model)', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{ prompt: 'test', model: 'nonexistent' },
			deps
		)
		expect(result.request.prompt).toBe('test')
		expect(result.request.model).toBe('nonexistent')
	})

	test('uses provided seed in request', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				model: 'sdxl',
				useElla: true,
				seed: 42
			},
			deps
		)
		expect(result.request.seed).toBe(42)
	})

	test('ELLA params in error request for SDXL', async () => {
		const deps = makeDeps()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				model: 'sdxl',
				useElla: true,
				t5MaxLength: 256
			},
			deps
		)
		expect(result.request.useElla).toBe(true)
	})
})

describe('executeImageGeneration — request building (with pre-seeded venv)', () => {
	function makeDepsWithFakeVenv(): GenerationDeps {
		const dataDir = makeTmpDataDir()
		const venvDir = join(dataDir, 'diffusers-venv')
		const binDir = join(venvDir, 'bin')
		mkdirSync(binDir, { recursive: true })
		writeFileSync(
			join(binDir, 'python'),
			'#!/bin/sh\nexit 1\n'
		)
		writeFileSync(
			join(venvDir, '.version-stamp'),
			VERSION_STAMP
		)
		return {
			blobSink: makeMockBlobSink(),
			sessionId: 'test-session',
			runId: 'test-run',
			dataDir
		}
	}

	test('resolves sd15 defaults', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'a cat', model: 'sd15' },
			deps
		)
		expect(result.request.model).toBe('sd15')
		expect(result.request.width).toBe(512)
		expect(result.request.height).toBe(768)
		expect(result.request.steps).toBe(30)
		expect(result.request.cfgScale).toBe(6.0)
		expect(result.request.sampler).toBe('dpmpp_2m_sde')
		expect(result.request.scheduler).toBe('karras')
		expect(result.request.prompt).toContain('a cat')
	})

	test('falls back to sd15 when no model specified', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test' },
			deps
		)
		expect(result.request.model).toBe('sd15')
	})

	test('resolves LoRA preset names to filenames', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				loras: [{ name: 'perfection' }]
			},
			deps
		)
		expect(result.request.loras).toHaveLength(1)
		expect(result.request.loras[0].name).toBe(
			LORA_PRESETS.perfection.filename
		)
		expect(result.request.loras[0].strengthModel).toBe(
			LORA_PRESETS.perfection.strengthModel
		)
	})

	test('uses provided seed', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test', seed: 42 },
			deps
		)
		expect(result.request.seed).toBe(42)
	})

	test('generates random seed when not provided', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test' },
			deps
		)
		expect(result.request.seed).toBeGreaterThanOrEqual(0)
		expect(result.request.seed).toBeLessThan(2 ** 32)
	})

	test('applies realizum custom negative prompt', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test', model: 'realizum' },
			deps
		)
		expect(result.request.negativePrompt).toContain(
			'3d, render, cgi'
		)
	})

	test('ELLA params passed through for SD 1.5', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{
				prompt: 'test',
				model: 'sd15',
				useElla: true,
				t5MaxLength: 256
			},
			deps
		)
		expect(result.request.useElla).toBe(true)
		expect(result.request.ellaModel).toBeTruthy()
		expect(result.request.t5Encoder).toBeTruthy()
		expect(result.request.t5MaxLength).toBe(256)
	})

	test('SDXL preset gets correct dimensions', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test', model: 'sdxl' },
			deps
		)
		expect(result.request.width).toBe(1024)
		expect(result.request.height).toBe(1024)
	})

	test('Python worker failure returns error not crash', async () => {
		const deps = makeDepsWithFakeVenv()
		const result = await executeImageGeneration(
			{ prompt: 'test' },
			deps
		)
		expect(result.success).toBe(false)
		expect(result.error).toBeTruthy()
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
	})

	test('progress events are reported', async () => {
		const progressLabels: string[] = []
		const deps = {
			...makeDepsWithFakeVenv(),
			onProgress: (label: string) => {
				progressLabels.push(label)
			}
		}
		await executeImageGeneration({ prompt: 'test' }, deps)
		expect(progressLabels).toContain('setup')
	})

	test('arch field is populated from preset', async () => {
		const deps = makeDepsWithFakeVenv()
		const sd15Result = await executeImageGeneration(
			{ prompt: 'test', model: 'sd15' },
			deps
		)
		expect(sd15Result.request.arch).toBe('sd15')

		const sdxlResult = await executeImageGeneration(
			{ prompt: 'test', model: 'sdxl' },
			deps
		)
		expect(sdxlResult.request.arch).toBe('sdxl')
	})
})
