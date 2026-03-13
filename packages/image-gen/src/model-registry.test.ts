import { describe, test, expect } from 'bun:test'
import {
	MODEL_PRESETS,
	LORA_PRESETS,
	ELLA_DEFAULTS
} from './model-registry'

describe('MODEL_PRESETS', () => {
	const presetNames = Object.keys(MODEL_PRESETS)

	test('all model presets exist', () => {
		expect(presetNames).toEqual(
			expect.arrayContaining([
				'sd15',
				'realizum',
				'cyberrealistic',
				'perfectdeliberate',
				'dreamshaper',
				'toonyou',
				'moodymix',
				'epicrealism',
				'majicmix',
				'sdxl'
			])
		)
		expect(presetNames).toHaveLength(10)
	})

	test('all presets have required fields', () => {
		for (const [_name, preset] of Object.entries(
			MODEL_PRESETS
		)) {
			expect(preset.pipelineClass).toBeTruthy()
			expect(preset.defaultWidth).toBeGreaterThan(0)
			expect(preset.defaultHeight).toBeGreaterThan(0)
			expect(preset.defaultSteps).toBeGreaterThan(0)
			expect(preset.defaultCfg).toBeGreaterThan(0)
			expect(['sd15', 'sdxl']).toContain(preset.arch)
			expect(preset.description).toBeTruthy()
			expect(typeof preset.ellaCompatible).toBe('boolean')
		}
	})

	test('sd15 and sdxl have hfModelId set', () => {
		expect(MODEL_PRESETS.sd15.hfModelId).toBeTruthy()
		expect(MODEL_PRESETS.sdxl.hfModelId).toBeTruthy()
	})

	test('CivitAI models have singleFileUrl set', () => {
		const civitaiModels = [
			'realizum',
			'perfectdeliberate',
			'toonyou',
			'moodymix',
			'majicmix'
		]
		for (const name of civitaiModels) {
			const preset = MODEL_PRESETS[name]
			expect(preset.singleFileUrl).toBeTruthy()
			expect(preset.singleFileFilename).toBeTruthy()
		}
	})

	test('SDXL preset uses StableDiffusionXLPipeline', () => {
		expect(MODEL_PRESETS.sdxl.pipelineClass).toBe(
			'StableDiffusionXLPipeline'
		)
	})

	test('SD 1.5 presets use StableDiffusionPipeline', () => {
		const sd15Models = [
			'sd15',
			'realizum',
			'cyberrealistic',
			'perfectdeliberate',
			'dreamshaper',
			'toonyou',
			'moodymix',
			'epicrealism',
			'majicmix'
		]
		for (const name of sd15Models) {
			expect(MODEL_PRESETS[name].pipelineClass).toBe(
				'StableDiffusionPipeline'
			)
		}
	})

	test('all presets have valid sampler defaults', () => {
		for (const preset of Object.values(MODEL_PRESETS)) {
			if (preset.recommendedSampler) {
				expect(typeof preset.recommendedSampler).toBe(
					'string'
				)
			}
			if (preset.recommendedScheduler) {
				expect(['normal', 'karras']).toContain(
					preset.recommendedScheduler
				)
			}
		}
	})

	test('ELLA compatibility is correct per arch', () => {
		for (const [_name, preset] of Object.entries(
			MODEL_PRESETS
		)) {
			if (preset.arch === 'sdxl') {
				expect(preset.ellaCompatible).toBe(false)
			}
			if (preset.arch === 'sd15') {
				expect(preset.ellaCompatible).toBe(true)
			}
		}
	})
})

describe('LORA_PRESETS', () => {
	test('perfection preset exists with required fields', () => {
		const perfection = LORA_PRESETS.perfection
		expect(perfection).toBeTruthy()
		expect(perfection.filename).toBeTruthy()
		expect(perfection.url).toBeTruthy()
		expect(perfection.compatibleArch).toContain('sd15')
	})
})

describe('ELLA_DEFAULTS', () => {
	test('has all required fields', () => {
		expect(ELLA_DEFAULTS.ellaModel).toBeTruthy()
		expect(ELLA_DEFAULTS.ellaHfRepo).toBeTruthy()
		expect(ELLA_DEFAULTS.t5Encoder).toBeTruthy()
		expect(ELLA_DEFAULTS.t5MaxLength).toBeGreaterThan(0)
	})
})
