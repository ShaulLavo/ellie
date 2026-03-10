/**
 * Core image generation logic.
 * Adapted from claw/bot — uses BlobSink + EventStore instead of ingestFile + FeedManager.
 */

import type { BlobSink } from '@ellie/trace'
import { ComfyUIClient } from './client'
import {
	MODEL_PRESETS,
	LORA_PRESETS,
	ELLA_DEFAULTS,
	DEFAULT_NEGATIVE_SD15,
	DEFAULT_NEGATIVE_SDXL,
	buildTxt2ImgWorkflow,
	buildEllaTxt2ImgWorkflow
} from './workflows/txt2img'
import type {
	Txt2ImgParams,
	EllaTxt2ImgParams,
	LoraInput
} from './workflows/txt2img'
import {
	ensureComfyReady,
	downloadRemainingModelsInBackground
} from './auto-setup'
import type { ProgressFn } from './auto-setup'
import { initImageTrace, imageTrace } from './image-trace'
import type {
	ImageGenerationBase,
	SamplerName,
	SchedulerName
} from '@ellie/schemas/generation'

// ── Types ────────────────────────────────────────────────────────────────────

export interface GenerateImageArgs {
	prompt: string
	negative_prompt?: string
	model?: string
	use_ella?: boolean
	ella_model?: string
	t5_encoder?: string
	t5_max_length?: number
	width?: number
	height?: number
	steps?: number
	cfg_scale?: number
	sampler_name?: SamplerName
	scheduler?: SchedulerName
	denoise?: number
	seed?: number
	batch_size?: number
	loras?: Array<{
		name: string
		strength_model?: number
		strength_clip?: number
	}>
	filename_prefix?: string
}

export interface ImageRecipe extends ImageGenerationBase {
	checkpoint: string
	filename_prefix: string
}

export interface GenerationResult {
	success: boolean
	recipe: ImageRecipe
	uploadId?: string
	url?: string
	mime?: string
	durationMs: number
	error?: string
}

export interface GenerationDeps {
	blobSink: BlobSink
	sessionId: string
	runId: string
	dataDir: string
	comfyUrl?: string
	comfyTimeout?: number
	civitaiToken?: string
	defaultModel?: string
	onProgress?: ProgressFn
}

// ── Core execution ───────────────────────────────────────────────────────────

export async function executeImageGeneration(
	args: GenerateImageArgs,
	deps: GenerationDeps
): Promise<GenerationResult> {
	const { blobSink, sessionId, runId, dataDir } = deps

	// Initialize trace logger
	initImageTrace(dataDir)

	// Resolve model preset
	const selectedModel =
		args.model ?? deps.defaultModel ?? 'realizum'
	const preset = MODEL_PRESETS[selectedModel]
	if (!preset) {
		const emptyRecipe = buildEmptyRecipe(
			args,
			selectedModel
		)
		return {
			success: false,
			recipe: emptyRecipe,
			durationMs: 0,
			error: `Unknown model: ${selectedModel}. Available: ${Object.keys(MODEL_PRESETS).join(', ')}`
		}
	}

	// ELLA only works with SD 1.5 models
	const useElla = args.use_ella ?? false
	if (useElla && !preset.ellaCompatible) {
		const emptyRecipe = buildEmptyRecipe(
			args,
			selectedModel
		)
		return {
			success: false,
			recipe: emptyRecipe,
			durationMs: 0,
			error:
				'ELLA is only compatible with SD 1.5 models, not SDXL'
		}
	}

	// Resolve LoRAs
	const resolvedLoras: (LoraInput & {
		preset?: string
	})[] = (args.loras ?? []).map(l => {
		const presetLora = LORA_PRESETS[l.name]
		if (presetLora) {
			return {
				name: presetLora.name,
				strengthModel:
					l.strength_model ?? presetLora.strengthModel,
				strengthClip:
					l.strength_clip ?? presetLora.strengthClip,
				preset: l.name
			}
		}
		return {
			name: l.name,
			strengthModel: l.strength_model ?? 1.0,
			strengthClip: l.strength_clip ?? 1.0
		}
	})

	// Resolve seed
	const resolvedSeed =
		args.seed != null && args.seed >= 0
			? args.seed
			: Math.floor(Math.random() * 2 ** 32)

	// Build recipe
	const archNegative =
		preset.arch === 'sdxl'
			? DEFAULT_NEGATIVE_SDXL
			: DEFAULT_NEGATIVE_SD15
	const recipe: ImageRecipe = {
		prompt: args.prompt,
		negative_prompt:
			args.negative_prompt ??
			preset.defaultNegativePrompt ??
			archNegative,
		model: selectedModel,
		checkpoint: preset.checkpoint,
		seed: resolvedSeed,
		steps: args.steps ?? preset.defaultSteps,
		cfg_scale: args.cfg_scale ?? preset.defaultCfg,
		sampler_name:
			args.sampler_name ??
			preset.recommendedSampler ??
			'euler',
		scheduler:
			args.scheduler ??
			preset.recommendedScheduler ??
			'normal',
		denoise: args.denoise ?? 1.0,
		width: args.width ?? preset.defaultWidth,
		height: args.height ?? preset.defaultHeight,
		batch_size: args.batch_size ?? 1,
		ella: useElla,
		ella_model: useElla
			? (args.ella_model ?? ELLA_DEFAULTS.ellaModel)
			: undefined,
		t5_encoder: useElla
			? (args.t5_encoder ?? ELLA_DEFAULTS.t5Encoder)
			: undefined,
		t5_max_length: useElla
			? (args.t5_max_length ?? ELLA_DEFAULTS.t5MaxLength)
			: undefined,
		loras: resolvedLoras.map(l => ({
			name: l.name,
			preset: l.preset,
			strength_model: l.strengthModel ?? 1.0,
			strength_clip: l.strengthClip ?? 1.0
		})),
		filename_prefix:
			args.filename_prefix ??
			(useElla ? 'ComfyUI_ELLA' : 'ComfyUI')
	}

	// Build workflow parameters
	const workflowParams: Txt2ImgParams = {
		prompt: recipe.prompt,
		negativePrompt: recipe.negative_prompt,
		checkpoint: recipe.checkpoint,
		width: recipe.width,
		height: recipe.height,
		steps: recipe.steps,
		cfgScale: recipe.cfg_scale,
		seed: recipe.seed,
		samplerName: recipe.sampler_name,
		scheduler: recipe.scheduler,
		denoise: recipe.denoise,
		batchSize: recipe.batch_size,
		filenamePrefix: recipe.filename_prefix,
		loras:
			resolvedLoras.length > 0 ? resolvedLoras : undefined
	}

	imageTrace({
		type: 'recipe_built',
		recipe: recipe as unknown as Record<string, unknown>
	})

	// Build workflow
	const workflow = useElla
		? buildEllaTxt2ImgWorkflow({
				...workflowParams,
				ellaModel: recipe.ella_model,
				t5Encoder: recipe.t5_encoder,
				t5MaxLength: recipe.t5_max_length
			} as EllaTxt2ImgParams)
		: buildTxt2ImgWorkflow(workflowParams)

	// Connect to ComfyUI
	const client = new ComfyUIClient({
		baseUrl: deps.comfyUrl ?? 'http://127.0.0.1:8188',
		timeout: deps.comfyTimeout ?? 600_000
	})

	const startTime = Date.now()

	// Progress callback — delegates to deps.onProgress if provided, always logs
	const onProgress: ProgressFn = (
		label,
		status,
		detail,
		step,
		totalSteps
	) => {
		console.info(
			`[image-gen] ${label}: ${status}${detail ? ` — ${detail}` : ''}${step != null ? ` (${step}/${totalSteps})` : ''}`
		)
		deps.onProgress?.(
			label,
			status,
			detail,
			step,
			totalSteps
		)
	}

	try {
		// Auto-setup: install ComfyUI + required models if needed
		onProgress(
			'setup',
			'started',
			'Preparing ComfyUI and required models...'
		)
		const setupResult = await ensureComfyReady(client, {
			checkpoint: recipe.checkpoint,
			loraFilenames: resolvedLoras.map(l => l.name),
			needsElla: useElla,
			civitaiToken: deps.civitaiToken,
			onProgress
		})

		if (!setupResult.ready) {
			const durationMs = Date.now() - startTime
			imageTrace({
				type: 'generation_failed',
				sessionId,
				error: `ComfyUI auto-setup failed: ${setupResult.error}`,
				durationMs,
				recipe: recipe as unknown as Record<string, unknown>
			})
			return {
				success: false,
				recipe,
				durationMs,
				error: `ComfyUI auto-setup failed: ${setupResult.error}`
			}
		}

		onProgress('setup', 'completed', 'Setup complete')

		// Download remaining models in the background
		downloadRemainingModelsInBackground({
			civitaiToken: deps.civitaiToken
		})

		// Queue the prompt
		onProgress('queue', 'started', 'Queueing workflow...')
		const { prompt_id, client_id } =
			await client.queuePrompt(workflow)
		console.info(
			`[image-gen] Queued prompt ${prompt_id} for model ${selectedModel}`
		)

		onProgress('queue', 'completed', 'Prompt queued')

		// Wait for completion with real-time progress
		onProgress('denoising', 'started', 'Sampling image...')
		const history = await client.waitForCompletion(
			prompt_id,
			client_id,
			({ step, totalSteps }) => {
				onProgress(
					'denoising',
					'running',
					undefined,
					step,
					totalSteps
				)
			}
		)
		onProgress(
			'denoising',
			'completed',
			'Sampling complete'
		)

		// Find output images
		const outputs = Object.values(history.outputs)
		const imageOutput = outputs.find(
			o => o.images && o.images.length > 0
		)
		if (!imageOutput?.images?.length) {
			const durationMs = Date.now() - startTime
			imageTrace({
				type: 'generation_failed',
				sessionId,
				error: 'ComfyUI produced no output images',
				durationMs,
				recipe: recipe as unknown as Record<string, unknown>
			})
			return {
				success: false,
				recipe,
				durationMs,
				error: 'ComfyUI produced no output images'
			}
		}

		const outputImage = imageOutput.images[0]

		// Fetch image bytes
		onProgress(
			'fetch',
			'started',
			'Downloading output image...'
		)
		const { data, mime } = await client.getOutputImage(
			outputImage.filename,
			outputImage.subfolder,
			outputImage.type
		)

		const durationMs = Date.now() - startTime
		const imageBuffer = Buffer.from(data)

		const ext = mime === 'image/png' ? 'png' : 'jpg'

		// Store via BlobSink — file lands at ${dataDir}/uploads/${uploadId}
		onProgress(
			'save',
			'started',
			'Saving generated image...'
		)
		const blobRef = await blobSink.write({
			traceId: runId,
			spanId: 'image-gen',
			role: 'generated_image',
			content: imageBuffer,
			mimeType: mime,
			ext
		})

		onProgress('save', 'completed', 'Saved generated image')

		console.info(
			`[image-gen] Complete: ${mime} ${imageBuffer.length} bytes in ${(durationMs / 1000).toFixed(1)}s`
		)

		imageTrace({
			type: 'generation_success',
			sessionId,
			uploadId: blobRef.uploadId,
			mime,
			durationMs,
			recipe: recipe as unknown as Record<string, unknown>
		})

		return {
			success: true,
			recipe,
			uploadId: blobRef.uploadId,
			url: blobRef.url,
			mime,
			durationMs
		}
	} catch (err) {
		const durationMs = Date.now() - startTime
		imageTrace({
			type: 'generation_failed',
			sessionId,
			error: String(err),
			durationMs,
			recipe: recipe as unknown as Record<string, unknown>
		})

		return {
			success: false,
			recipe,
			durationMs,
			error: String(err)
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEmptyRecipe(
	args: GenerateImageArgs,
	model: string
): ImageRecipe {
	return {
		prompt: args.prompt,
		negative_prompt:
			args.negative_prompt ?? DEFAULT_NEGATIVE_SD15,
		model,
		checkpoint: '',
		seed: args.seed ?? -1,
		steps: args.steps ?? 25,
		cfg_scale: args.cfg_scale ?? 7,
		sampler_name: args.sampler_name ?? 'euler',
		scheduler: args.scheduler ?? 'normal',
		denoise: args.denoise ?? 1.0,
		width: args.width ?? 512,
		height: args.height ?? 512,
		batch_size: args.batch_size ?? 1,
		ella: args.use_ella ?? false,
		loras: [],
		filename_prefix: args.filename_prefix ?? 'ComfyUI'
	}
}
