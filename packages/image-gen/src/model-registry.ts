/**
 * Model presets and LoRA definitions for Diffusers-based image generation.
 * Migrated from comfyui/workflows/txt2img.ts with HF/CivitAI source info.
 */

import type {
	SamplerName,
	SchedulerName
} from '@ellie/schemas/generation'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelPreset {
	/** HuggingFace model ID for from_pretrained() loading */
	hfModelId?: string
	/** Direct download URL for .safetensors file (CivitAI) */
	singleFileUrl?: string
	/** Expected filename when downloaded as single file */
	singleFileFilename?: string
	/** Pipeline class to use */
	pipelineClass:
		| 'StableDiffusionPipeline'
		| 'StableDiffusionXLPipeline'
	defaultWidth: number
	defaultHeight: number
	defaultSteps: number
	defaultCfg: number
	arch: 'sd15' | 'sdxl'
	description: string
	strengths: string[]
	weaknesses?: string[]
	recommendedSampler?: SamplerName
	recommendedScheduler?: SchedulerName
	/** Quality tokens appended to the user's prompt */
	defaultPositivePrompt?: string
	defaultNegativePrompt?: string
	/** Textual inversion embeddings to auto-load with this model */
	textualInversions?: string[]
	ellaCompatible: boolean
}

export interface TextualInversionPreset {
	/** Filename of the embedding file */
	filename: string
	/** Direct download URL */
	url: string
	/** Token to use in prompts (e.g. "CyberRealistic_Negative_New") */
	token: string
	compatibleArch: ('sd15' | 'sdxl')[]
	description: string
}

export interface LoraPreset {
	/** Filename of the LoRA weights */
	filename: string
	/** Direct download URL */
	url: string
	strengthModel: number
	strengthClip: number
	compatibleArch: ('sd15' | 'sdxl')[]
	description: string
	recommendedStrengthRange: [number, number]
	tips?: string
}

// ── Default positive prompts ─────────────────────────────────────────────────

export const DEFAULT_POSITIVE_SD15 =
	'sharp focus, hyper realistic, lifelike texture, rich colors, ' +
	'film grain, camera f1.6 lens, nikon d850, kodak portra 400'

export const DEFAULT_POSITIVE_SDXL =
	'high quality, detailed, sharp focus, professional photography'

// ── Default negative prompts ─────────────────────────────────────────────────

export const DEFAULT_NEGATIVE_SD15 =
	'(worst quality, low quality:1.4), (blurry:1.2), jpeg artifacts, compression artifacts, ' +
	'bad anatomy, wrong anatomy, poorly drawn face, poorly drawn hands, mutation, deformed, ' +
	'mutated, disfigured, ugly, extra limbs, extra fingers, fused fingers, too many fingers, ' +
	'mutated hands, malformed hands, missing limbs, missing arms, missing legs, extra arms, ' +
	'extra legs, long neck, cloned face, duplicate, morbid, gross proportions, bad proportions, ' +
	'cropped, out of frame, lowres, text, watermark, signature, logo, username, ' +
	'(cartoon, anime, illustration, painting, drawing, sketch, 3d, render, cgi, doll:1.3)'

export const DEFAULT_NEGATIVE_SDXL =
	'(worst quality, low quality:1.4), (blurry:1.2), jpeg artifacts, poorly drawn, ' +
	'bad anatomy, wrong anatomy, deformed, mutated, disfigured, ugly, text, watermark, ' +
	'signature, logo, (cartoon, anime, illustration, painting, drawing, sketch:1.3), ' +
	'3d render, cgi, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, ' +
	'extra limbs, cloned face, missing arms, missing legs, fused fingers, too many fingers, long neck'

// ── Model presets ────────────────────────────────────────────────────────────

export const MODEL_PRESETS: Record<string, ModelPreset> = {
	sd15: {
		hfModelId: 'sd-legacy/stable-diffusion-v1-5',
		pipelineClass: 'StableDiffusionPipeline',
		defaultWidth: 512,
		defaultHeight: 768,
		defaultSteps: 30,
		defaultCfg: 6.0,
		arch: 'sd15',
		description:
			'Base Stable Diffusion 1.5. Versatile, best LoRA compatibility.',
		strengths: [
			'LoRA compatibility',
			'fast generation',
			'huge community ecosystem'
		],
		weaknesses: [
			'weaker anatomy than fine-tuned models',
			'512px native resolution'
		],
		recommendedSampler: 'dpmpp_2m_sde',
		recommendedScheduler: 'karras',
		defaultPositivePrompt: DEFAULT_POSITIVE_SD15,
		ellaCompatible: true
	},
	realizum: {
		singleFileUrl:
			'https://civitai.com/api/download/models/1821343',
		singleFileFilename: 'realizum_v10.safetensors',
		pipelineClass: 'StableDiffusionPipeline',
		defaultWidth: 640,
		defaultHeight: 960,
		defaultSteps: 25,
		defaultCfg: 5.0,
		arch: 'sd15',
		description:
			'Realistic style. Good for portraits, people, natural scenes. Slightly warm tones.',
		strengths: [
			'natural skin tones',
			'warm color palette',
			'good landscapes'
		],
		weaknesses: ['warm bias may not suit all scenes'],
		recommendedSampler: 'dpmpp_2m',
		recommendedScheduler: 'karras',
		defaultPositivePrompt:
			'sharp focus, hyper realistic, lifelike texture, rich colors, ' +
			'natural lighting, film grain, warm tones',
		defaultNegativePrompt:
			'(3d, render, cgi, doll, painting, fake, cartoon, 3d modeling:1.4), ' +
			'(worst quality, low quality:1.4), deformed, malformed, bad teeth, bad hands, ' +
			'bad fingers, bad eyes, long body, blurry, duplicated, cloned, duplicate body parts, ' +
			'disfigured, extra limbs, fused fingers, extra fingers, twisted, distorted, ' +
			'malformed hands, mutated hands, mutated fingers, conjoined, missing limbs, ' +
			'bad anatomy, bad proportions, logo, watermark, text, copyright, signature, ' +
			'lowres, mutated, artifacts, gross, ugly',
		ellaCompatible: true
	},
	cyberrealistic: {
		singleFileUrl:
			'https://civitai.com/api/download/models/2681234',
		singleFileFilename: 'cyberrealistic_final.safetensors',
		pipelineClass: 'StableDiffusionPipeline',
		defaultWidth: 512,
		defaultHeight: 768,
		defaultSteps: 32,
		defaultCfg: 7.0,
		arch: 'sd15',
		description:
			'Photorealistic. Best for lifelike photos of people. Sharp detail, neutral colors.',
		strengths: [
			'photorealistic skin/hair',
			'sharp detail',
			'neutral color balance'
		],
		weaknesses: [
			'less creative/artistic range',
			'can look sterile without careful prompting'
		],
		recommendedSampler: 'dpmpp_2m_sde',
		recommendedScheduler: 'karras',
		defaultPositivePrompt:
			'masterpiece, best quality, ultra-detailed, photorealistic',
		defaultNegativePrompt: 'CyberRealistic_Negative',
		textualInversions: ['cyberrealistic_negative'],
		ellaCompatible: true
	},
	perfectdeliberate: {
		singleFileUrl:
			'https://civitai.com/api/download/models/253055?type=Model&format=SafeTensor&size=pruned&fp=fp16',
		singleFileFilename:
			'perfectdeliberate_v5SD15.safetensors',
		pipelineClass: 'StableDiffusionPipeline',
		defaultWidth: 512,
		defaultHeight: 768,
		defaultSteps: 30,
		defaultCfg: 6.0,
		arch: 'sd15',
		description:
			'Artistic realism. Balanced between illustration and photo. Good for creative portraits.',
		strengths: [
			'illustration-photo blend',
			'creative flexibility',
			'good composition'
		],
		weaknesses: ['less photorealistic than cyberrealistic'],
		recommendedSampler: 'euler_ancestral',
		recommendedScheduler: 'karras',
		defaultPositivePrompt:
			'sharp focus, artistic realism, cinematic composition, rich colors, ' +
			'natural lighting, detailed textures, professional portrait',
		ellaCompatible: true
	},
	moodymix: {
		singleFileUrl:
			'https://civitai.com/api/download/models/865501?type=Model&format=SafeTensor&size=pruned&fp=fp16',
		singleFileFilename: 'moodyRealMix_v50.safetensors',
		pipelineClass: 'StableDiffusionPipeline',
		defaultWidth: 512,
		defaultHeight: 768,
		defaultSteps: 30,
		defaultCfg: 8.0,
		arch: 'sd15',
		description:
			'Moody, cinematic realism. Strong atmosphere, dramatic lighting.',
		strengths: [
			'dramatic lighting',
			'cinematic atmosphere',
			'dark/moody scenes'
		],
		weaknesses: [
			'dark bias',
			'not ideal for bright/cheerful scenes'
		],
		recommendedSampler: 'dpmpp_2m_sde',
		recommendedScheduler: 'karras',
		defaultPositivePrompt:
			'sharp focus, cinematic lighting, dramatic atmosphere, moody tones, ' +
			'film grain, rich shadows, hyper realistic, lifelike texture',
		ellaCompatible: true
	},
	sdxl: {
		hfModelId: 'stabilityai/stable-diffusion-xl-base-1.0',
		pipelineClass: 'StableDiffusionXLPipeline',
		defaultWidth: 1024,
		defaultHeight: 1024,
		defaultSteps: 25,
		defaultCfg: 5.0,
		arch: 'sdxl',
		description:
			'SDXL 1.0 base. Higher resolution, better anatomy, better text comprehension.',
		strengths: [
			'1024px native',
			'better anatomy',
			'better prompt comprehension',
			'more detail'
		],
		weaknesses: [
			'slower',
			'fewer compatible LoRAs',
			'more VRAM'
		],
		recommendedSampler: 'dpmpp_2m',
		recommendedScheduler: 'karras',
		defaultPositivePrompt: DEFAULT_POSITIVE_SDXL,
		defaultNegativePrompt: DEFAULT_NEGATIVE_SDXL,
		ellaCompatible: false
	}
}

// ── LoRA presets ──────────────────────────────────────────────────────────────

export const LORA_PRESETS: Record<string, LoraPreset> = {
	perfection: {
		filename: 'perfection_style_sd15.safetensors',
		url: 'https://civitai.com/api/download/models/486099',
		strengthModel: 0.8,
		strengthClip: 0.8,
		compatibleArch: ['sd15'],
		description:
			'Dramatically improves hand, face, and body anatomy. Reduces common SD 1.5 deformities.',
		recommendedStrengthRange: [0.5, 0.9],
		tips: 'Higher strength (0.8-0.9) for close-up portraits, lower (0.5-0.6) when combined with other LoRAs.'
	}
}

// ── Textual Inversion presets ─────────────────────────────────────────────────

export const TI_PRESETS: Record<
	string,
	TextualInversionPreset
> = {
	cyberrealistic_negative: {
		filename: 'CyberRealistic_Negative.pt',
		url: 'https://civitai.com/api/download/models/82745',
		token: 'CyberRealistic_Negative',
		compatibleArch: ['sd15'],
		description:
			'Negative embedding tuned for CyberRealistic. Dramatically reduces artifacts and improves realism when used in negative prompt.'
	}
}

// ── ELLA config ──────────────────────────────────────────────────────────────

export const ELLA_DEFAULTS = {
	ellaModel: 'ella-sd1.5-tsc-t5xl.safetensors',
	ellaHfRepo: 'QQGYLab/ELLA',
	ellaHfFilename: 'ella-sd1.5-tsc-t5xl.safetensors',
	t5Encoder: 'google/flan-t5-xl',
	t5MaxLength: 128
}
