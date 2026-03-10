/**
 * Text-to-image workflow templates for ComfyUI.
 * Builds standard and ELLA-enhanced txt2img node graphs in ComfyUI's API format.
 */

import type {
	SamplerName,
	SchedulerName
} from '@ellie/schemas/generation'

export interface LoraInput {
	/** LoRA filename (e.g. "perfection style SD1.5.safetensors") */
	name: string
	/** Strength for model weights (default: 1.0) */
	strengthModel?: number
	/** Strength for CLIP weights (default: 1.0) */
	strengthClip?: number
}

export interface Txt2ImgParams {
	prompt: string
	negativePrompt: string
	checkpoint: string
	width: number
	height: number
	steps: number
	cfgScale: number
	seed: number
	samplerName?: SamplerName
	scheduler?: SchedulerName
	denoise?: number
	batchSize?: number
	filenamePrefix?: string
	loras?: LoraInput[]
}

export interface ModelPreset {
	checkpoint: string
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
	defaultNegativePrompt?: string
	ellaCompatible: boolean
}

export interface LoraPreset extends LoraInput {
	compatibleArch: ('sd15' | 'sdxl')[]
	description: string
	recommendedStrengthRange: [number, number]
	tips?: string
}

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

export const MODEL_PRESETS: Record<string, ModelPreset> = {
	sd15: {
		checkpoint: 'v1-5-pruned-emaonly.safetensors',
		defaultWidth: 512,
		defaultHeight: 512,
		defaultSteps: 25,
		defaultCfg: 7.5,
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
		recommendedSampler: 'dpmpp_2m',
		recommendedScheduler: 'karras',
		ellaCompatible: true
	},
	realizum: {
		checkpoint: 'realizum_v10.safetensors',
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
		checkpoint: 'cyberrealistic_final.safetensors',
		defaultWidth: 512,
		defaultHeight: 768,
		defaultSteps: 30,
		defaultCfg: 5.0,
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
		recommendedSampler: 'dpmpp_sde',
		recommendedScheduler: 'karras',
		ellaCompatible: true
	},
	perfectdeliberate: {
		checkpoint: 'perfectdeliberate_v5SD15.safetensors',
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
		ellaCompatible: true
	},
	moodymix: {
		checkpoint: 'moodyRealMix_v50.safetensors',
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
		ellaCompatible: true
	},
	sdxl: {
		checkpoint: 'sd_xl_base_1.0.safetensors',
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
		defaultNegativePrompt: DEFAULT_NEGATIVE_SDXL,
		ellaCompatible: false
	}
}

/** Known LoRA presets available via setup-comfy. */
export const LORA_PRESETS: Record<string, LoraPreset> = {
	perfection: {
		name: 'perfection style SD1.5.safetensors',
		strengthModel: 0.8,
		strengthClip: 0.8,
		compatibleArch: ['sd15'],
		description:
			'Dramatically improves hand, face, and body anatomy. Reduces common SD 1.5 deformities.',
		recommendedStrengthRange: [0.5, 0.9],
		tips: 'Higher strength (0.8-0.9) for close-up portraits, lower (0.5-0.6) when combined with other LoRAs.'
	}
}

/**
 * Build LoRA loader nodes that chain from checkpoint → lora1 → lora2 → ...
 */
function buildLoraChain(
	loras: LoraInput[],
	startNodeId: number
): {
	nodes: Record<string, unknown>
	lastNodeId: string
} {
	const nodes: Record<string, unknown> = {}
	let prevModelRef: [string, number] = ['4', 0]
	let prevClipRef: [string, number] = ['4', 1]

	for (let i = 0; i < loras.length; i++) {
		const nodeId = String(startNodeId + i)
		const lora = loras[i]
		nodes[nodeId] = {
			class_type: 'LoraLoader',
			inputs: {
				lora_name: lora.name,
				strength_model: lora.strengthModel ?? 1.0,
				strength_clip: lora.strengthClip ?? 1.0,
				model: prevModelRef,
				clip: prevClipRef
			}
		}
		prevModelRef = [nodeId, 0]
		prevClipRef = [nodeId, 1]
	}

	const lastId = String(startNodeId + loras.length - 1)
	return { nodes, lastNodeId: lastId }
}

/**
 * Build a standard ComfyUI API-format workflow for text-to-image generation.
 * Supports optional LoRA stacking.
 */
export function buildTxt2ImgWorkflow(
	params: Txt2ImgParams
): Record<string, unknown> {
	const sampler = params.samplerName ?? 'euler'
	const scheduler = params.scheduler ?? 'normal'
	const loras = params.loras ?? []

	let modelRef: [string, number] = ['4', 0]
	let clipRef: [string, number] = ['4', 1]
	let loraNodes: Record<string, unknown> = {}

	if (loras.length > 0) {
		const chain = buildLoraChain(loras, 20)
		loraNodes = chain.nodes
		modelRef = [chain.lastNodeId, 0]
		clipRef = [chain.lastNodeId, 1]
	}

	return {
		'3': {
			class_type: 'KSampler',
			inputs: {
				seed: params.seed,
				steps: params.steps,
				cfg: params.cfgScale,
				sampler_name: sampler,
				scheduler,
				denoise: params.denoise ?? 1,
				model: modelRef,
				positive: ['6', 0],
				negative: ['7', 0],
				latent_image: ['5', 0]
			}
		},
		'4': {
			class_type: 'CheckpointLoaderSimple',
			inputs: { ckpt_name: params.checkpoint }
		},
		'5': {
			class_type: 'EmptyLatentImage',
			inputs: {
				width: params.width,
				height: params.height,
				batch_size: params.batchSize ?? 1
			}
		},
		'6': {
			class_type: 'CLIPTextEncode',
			inputs: {
				text: params.prompt,
				clip: clipRef
			}
		},
		'7': {
			class_type: 'CLIPTextEncode',
			inputs: {
				text: params.negativePrompt,
				clip: clipRef
			}
		},
		'8': {
			class_type: 'VAEDecode',
			inputs: {
				samples: ['3', 0],
				vae: ['4', 2]
			}
		},
		'9': {
			class_type: 'SaveImage',
			inputs: {
				filename_prefix: params.filenamePrefix ?? 'ComfyUI',
				images: ['8', 0]
			}
		},
		...loraNodes
	}
}

// ── ELLA workflow ────────────────────────────────────────────────────────────

export interface EllaTxt2ImgParams extends Txt2ImgParams {
	ellaModel?: string
	t5Encoder?: string
	t5MaxLength?: number
}

export const ELLA_DEFAULTS = {
	ellaModel: 'ella-sd1.5-tsc-t5xl.safetensors',
	t5Encoder: 'flan-t5-xl',
	t5MaxLength: 128
}

/**
 * Build a ComfyUI API-format workflow using ELLA for enhanced text understanding.
 * Requires ComfyUI-ELLA custom node installed.
 */
export function buildEllaTxt2ImgWorkflow(
	params: EllaTxt2ImgParams
): Record<string, unknown> {
	const sampler = params.samplerName ?? 'euler'
	const scheduler = params.scheduler ?? 'normal'
	const ellaModel =
		params.ellaModel ?? ELLA_DEFAULTS.ellaModel
	const t5Encoder =
		params.t5Encoder ?? ELLA_DEFAULTS.t5Encoder
	const t5MaxLength =
		params.t5MaxLength ?? ELLA_DEFAULTS.t5MaxLength
	const loras = params.loras ?? []

	let modelRef: [string, number] = ['4', 0]
	let clipRef: [string, number] = ['4', 1]
	let loraNodes: Record<string, unknown> = {}

	if (loras.length > 0) {
		const chain = buildLoraChain(loras, 20)
		loraNodes = chain.nodes
		modelRef = [chain.lastNodeId, 0]
		clipRef = [chain.lastNodeId, 1]
	}

	return {
		'3': {
			class_type: 'KSampler',
			inputs: {
				seed: params.seed,
				steps: params.steps,
				cfg: params.cfgScale,
				sampler_name: sampler,
				scheduler,
				denoise: params.denoise ?? 1,
				model: ['12', 0],
				positive: ['6', 0],
				negative: ['7', 0],
				latent_image: ['5', 0]
			}
		},
		'4': {
			class_type: 'CheckpointLoaderSimple',
			inputs: { ckpt_name: params.checkpoint }
		},
		'5': {
			class_type: 'EmptyLatentImage',
			inputs: {
				width: params.width,
				height: params.height,
				batch_size: params.batchSize ?? 1
			}
		},
		'6': {
			class_type: 'EllaTextEncode',
			inputs: {
				text: params.prompt,
				ella: ['12', 1],
				text_encoder: ['11', 0],
				clip: clipRef,
				text_clip: params.prompt
			}
		},
		'7': {
			class_type: 'CLIPTextEncode',
			inputs: {
				text: params.negativePrompt,
				clip: clipRef
			}
		},
		'8': {
			class_type: 'VAEDecode',
			inputs: {
				samples: ['3', 0],
				vae: ['4', 2]
			}
		},
		'9': {
			class_type: 'SaveImage',
			inputs: {
				filename_prefix:
					params.filenamePrefix ?? 'ComfyUI_ELLA',
				images: ['8', 0]
			}
		},
		'10': {
			class_type: 'ELLALoader',
			inputs: { name: ellaModel }
		},
		'11': {
			class_type: 'T5TextEncoderLoader',
			inputs: {
				name: t5Encoder,
				max_length: t5MaxLength,
				dtype: 'auto'
			}
		},
		'12': {
			class_type: 'SetEllaTimesteps',
			inputs: {
				model: modelRef,
				ella: ['10', 0],
				scheduler,
				steps: params.steps,
				denoise: params.denoise ?? 1
			}
		},
		...loraNodes
	}
}
