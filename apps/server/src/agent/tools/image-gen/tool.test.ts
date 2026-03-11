import { describe, test, expect } from 'bun:test'
import { MODEL_PRESETS } from '@ellie/image-gen'

describe('image-gen tool — model presets', () => {
	test('tool has model presets available', () => {
		const keys = Object.keys(MODEL_PRESETS)
		expect(keys.length).toBeGreaterThan(0)
		expect(keys).toContain('sd15')
		expect(keys).toContain('sdxl')
	})

	test('all model presets have descriptions', () => {
		for (const [_key, preset] of Object.entries(
			MODEL_PRESETS
		)) {
			expect(preset.description).toBeTruthy()
		}
	})
})

describe('image-gen tool — progress phase mapping', () => {
	function mapProgressPhase(label: string): string {
		switch (label) {
			case 'setup':
			case 'download':
			case 'load':
			case 'lora':
			case 'ella':
				return 'setup'
			case 'denoising':
				return 'denoising'
			case 'save':
				return 'save'
			default:
				return label
		}
	}

	test('download maps to setup phase', () => {
		expect(mapProgressPhase('download')).toBe('setup')
	})

	test('load maps to setup phase', () => {
		expect(mapProgressPhase('load')).toBe('setup')
	})

	test('lora maps to setup phase', () => {
		expect(mapProgressPhase('lora')).toBe('setup')
	})

	test('ella maps to setup phase', () => {
		expect(mapProgressPhase('ella')).toBe('setup')
	})

	test('denoising maps to denoising phase', () => {
		expect(mapProgressPhase('denoising')).toBe('denoising')
	})

	test('save maps to save phase', () => {
		expect(mapProgressPhase('save')).toBe('save')
	})

	test('unknown label passes through', () => {
		expect(mapProgressPhase('custom')).toBe('custom')
	})
})

describe('image-gen tool — progress label formatting', () => {
	function formatProgressLabel(label: string): string {
		switch (label) {
			case 'setup':
				return 'Setting up environment'
			case 'download':
				return 'Downloading'
			case 'load':
				return 'Loading model'
			case 'lora':
				return 'Loading LoRA'
			case 'ella':
				return 'Loading ELLA'
			case 'denoising':
				return 'Generating image'
			case 'save':
				return 'Saving image'
			default:
				return label
		}
	}

	test('denoising formats as Generating image', () => {
		expect(formatProgressLabel('denoising')).toBe(
			'Generating image'
		)
	})

	test('download formats as Downloading', () => {
		expect(formatProgressLabel('download')).toBe(
			'Downloading'
		)
	})

	test('load formats as Loading model', () => {
		expect(formatProgressLabel('load')).toBe(
			'Loading model'
		)
	})
})
