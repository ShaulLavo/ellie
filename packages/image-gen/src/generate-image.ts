/**
 * Core image generation logic using Diffusers.
 *
 * Responsibilities:
 *   - Request validation and preset resolution
 *   - Building the resolved generation config
 *   - Service supervision (ensure FastAPI service is running)
 *   - Blob upload of generated images
 *   - Trace logging
 */

import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import type { BlobSink } from '@ellie/trace'
import {
	MODEL_PRESETS,
	LORA_PRESETS,
	TI_PRESETS,
	ELLA_DEFAULTS,
	DEFAULT_NEGATIVE_SD15,
	DEFAULT_NEGATIVE_SDXL
} from './model-registry'
import type { ProgressFn } from './auto-setup'
import { initImageTrace, imageTrace } from './image-trace'
import { ensureImageGenService } from './service-supervisor'
import { serviceGenerate } from './service-client'
import type {
	GenerateImageRequest,
	ResolvedGenerationConfig,
	GenerationResult
} from '@ellie/schemas/generation'

// Re-export types for consumers
export type {
	GenerateImageRequest,
	ResolvedGenerationConfig,
	GenerationResult
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface GenerationDeps {
	blobSink: BlobSink
	sessionId: string
	runId: string
	dataDir: string
	civitaiToken?: string
	defaultModel?: string
	onProgress?: ProgressFn
}

// ── Generation lock ─────────────────────────────────────────────────────────
// Only one generation at a time. Concurrent calls queue up and run sequentially.

let generationLock: Promise<void> = Promise.resolve()
let generationInProgress = false

// ── Core execution ──────────────────────────────────────────────────────────

export async function executeImageGeneration(
	args: GenerateImageRequest,
	deps: GenerationDeps
): Promise<GenerationResult> {
	// Queue behind any in-progress generation
	const previousLock = generationLock
	let releaseLock: () => void
	generationLock = new Promise<void>(
		resolve => (releaseLock = resolve)
	)

	if (generationInProgress) {
		console.info(
			'[image-gen] Generation queued — waiting for previous generation to finish'
		)
	}

	try {
		await previousLock
	} catch {
		// Previous generation failed — we still proceed
	}

	generationInProgress = true
	try {
		return await doGenerate(args, deps)
	} finally {
		generationInProgress = false
		releaseLock!()
	}
}

async function doGenerate(
	args: GenerateImageRequest,
	deps: GenerationDeps
): Promise<GenerationResult> {
	const { blobSink, sessionId, runId, dataDir } = deps

	initImageTrace(dataDir)

	// Resolve model preset
	const selectedModel =
		args.model ?? deps.defaultModel ?? 'sd15'
	const preset = MODEL_PRESETS[selectedModel]
	if (!preset) {
		const emptyConfig = buildEmptyConfig(
			args,
			selectedModel
		)
		return {
			success: false,
			request: emptyConfig,
			durationMs: 0,
			error: `Unknown model: ${selectedModel}. Available: ${Object.keys(MODEL_PRESETS).join(', ')}`
		}
	}

	// ELLA validation: SD 1.5 only
	const useElla = args.useElla ?? false
	if (useElla && !preset.ellaCompatible) {
		const emptyConfig = buildEmptyConfig(
			args,
			selectedModel
		)
		return {
			success: false,
			request: emptyConfig,
			durationMs: 0,
			error:
				'ELLA is only compatible with SD 1.5 models, not SDXL'
		}
	}

	// Resolve LoRAs
	const resolvedLoras = (args.loras ?? []).map(l => {
		const presetLora = LORA_PRESETS[l.name]
		if (presetLora) {
			return {
				name: l.name,
				preset: l.name,
				filename: presetLora.filename,
				url: presetLora.url,
				strengthModel:
					l.strengthModel ?? presetLora.strengthModel,
				strengthClip:
					l.strengthClip ?? presetLora.strengthClip
			}
		}
		return {
			name: l.name,
			preset: undefined as string | undefined,
			filename: l.name,
			url: undefined as string | undefined,
			strengthModel: l.strengthModel ?? 1.0,
			strengthClip: l.strengthClip ?? 1.0
		}
	})

	// Resolve seed
	const resolvedSeed =
		args.seed != null && args.seed >= 0
			? args.seed
			: Math.floor(Math.random() * 2 ** 32)

	// Build resolved config
	const archNegative =
		preset.arch === 'sdxl'
			? DEFAULT_NEGATIVE_SDXL
			: DEFAULT_NEGATIVE_SD15

	const finalPrompt = preset.defaultPositivePrompt
		? `${args.prompt}, ${preset.defaultPositivePrompt}`
		: args.prompt

	const resolved: ResolvedGenerationConfig = {
		prompt: finalPrompt,
		negativePrompt:
			args.negativePrompt ??
			preset.defaultNegativePrompt ??
			archNegative,
		model: selectedModel,
		checkpoint:
			preset.singleFileFilename ?? preset.hfModelId ?? '',
		arch: preset.arch,
		seed: resolvedSeed,
		steps: args.steps ?? preset.defaultSteps,
		cfgScale: args.cfgScale ?? preset.defaultCfg,
		sampler:
			args.sampler ?? preset.recommendedSampler ?? 'euler',
		scheduler:
			args.scheduler ??
			preset.recommendedScheduler ??
			'normal',
		denoise: args.denoise ?? 1.0,
		width: args.width ?? preset.defaultWidth,
		height: args.height ?? preset.defaultHeight,
		batchSize: args.batchSize ?? 1,
		clipSkip: args.clipSkip ?? preset.defaultClipSkip ?? 1,
		useADetailer:
			args.useADetailer ??
			preset.defaultUseADetailer ??
			false,
		adetailerStrength: args.adetailerStrength ?? 0.4,
		adetailerSteps: args.adetailerSteps ?? 20,
		adetailerConfidence: args.adetailerConfidence ?? 0.3,
		adetailerDetectFaces: args.adetailerDetectFaces ?? true,
		adetailerDetectHands: args.adetailerDetectHands ?? true,
		adetailerMaskPadding: args.adetailerMaskPadding ?? 32,
		adetailerMaskBlur: args.adetailerMaskBlur ?? 12,
		useElla,
		ellaModel: useElla
			? (args.ellaModel ?? ELLA_DEFAULTS.ellaModel)
			: undefined,
		t5Encoder: useElla
			? (args.t5Encoder ?? ELLA_DEFAULTS.t5Encoder)
			: undefined,
		t5MaxLength: useElla
			? (args.t5MaxLength ?? ELLA_DEFAULTS.t5MaxLength)
			: undefined,
		loras: resolvedLoras.map(l => ({
			name: l.filename,
			preset: l.preset,
			strengthModel: l.strengthModel,
			strengthClip: l.strengthClip
		}))
	}

	imageTrace({
		type: 'recipe_built',
		recipe: resolved as unknown as Record<string, unknown>
	})

	const startTime = Date.now()

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
		// Ensure the FastAPI service is running
		onProgress(
			'setup',
			'started',
			'Preparing Diffusers environment...'
		)

		let baseUrl: string
		try {
			baseUrl = await ensureImageGenService({
				dataDir,
				onProgress
			})
		} catch (err) {
			const durationMs = Date.now() - startTime
			imageTrace({
				type: 'generation_failed',
				sessionId,
				error: `Service setup failed: ${String(err)}`,
				durationMs,
				recipe: resolved as unknown as Record<
					string,
					unknown
				>
			})
			return {
				success: false,
				request: resolved,
				durationMs,
				error: `Service setup failed: ${String(err)}`
			}
		}

		onProgress('setup', 'completed', 'Setup complete')

		// Build the service request config
		const modelsDir = join(dataDir, 'diffusers-models')
		const serviceConfig: Record<string, unknown> = {
			prompt: resolved.prompt,
			negativePrompt: resolved.negativePrompt,
			arch: resolved.arch,
			seed: resolved.seed,
			steps: resolved.steps,
			cfgScale: resolved.cfgScale,
			sampler: resolved.sampler,
			scheduler: resolved.scheduler,
			width: resolved.width,
			height: resolved.height,
			batchSize: resolved.batchSize,
			clipSkip: resolved.clipSkip,
			useADetailer: resolved.useADetailer,
			adetailerStrength: resolved.adetailerStrength,
			adetailerSteps: resolved.adetailerSteps,
			adetailerConfidence: resolved.adetailerConfidence,
			adetailerDetectFaces: resolved.adetailerDetectFaces,
			adetailerDetectHands: resolved.adetailerDetectHands,
			adetailerMaskPadding: resolved.adetailerMaskPadding,
			adetailerMaskBlur: resolved.adetailerMaskBlur,
			useElla: resolved.useElla,
			ellaModel: resolved.ellaModel,
			t5Encoder: resolved.t5Encoder,
			t5MaxLength: resolved.t5MaxLength,
			modelsDir,
			civitaiToken: deps.civitaiToken
		}

		if (preset.hfModelId) {
			serviceConfig.hfModelId = preset.hfModelId
		}
		if (preset.singleFileUrl) {
			serviceConfig.singleFileUrl = preset.singleFileUrl
			serviceConfig.singleFileFilename =
				preset.singleFileFilename
			const localPath = join(
				modelsDir,
				'checkpoints',
				preset.singleFileFilename ?? 'model.safetensors'
			)
			if (await Bun.file(localPath).exists()) {
				serviceConfig.singleFilePath = localPath
			}
		}

		// LoRA download info
		if (resolvedLoras.length > 0) {
			serviceConfig.loras = resolvedLoras.map(l => ({
				name: l.name,
				filename: l.filename,
				url: l.url,
				path: l.url
					? undefined
					: join(modelsDir, 'loras', l.filename),
				strengthModel: l.strengthModel,
				strengthClip: l.strengthClip
			}))
		}

		// Textual inversions
		const tiNames = preset.textualInversions ?? []
		if (tiNames.length > 0) {
			const tiConfigs: Array<Record<string, string>> = []
			for (const tiName of tiNames) {
				const tiPreset = TI_PRESETS[tiName]
				if (!tiPreset) continue
				tiConfigs.push({
					token: tiPreset.token,
					filename: tiPreset.filename,
					url: tiPreset.url,
					path: join(
						modelsDir,
						'embeddings',
						tiPreset.filename
					)
				})
			}
			serviceConfig.textualInversions = tiConfigs
		}

		// ELLA
		if (useElla) {
			serviceConfig.ellaModelPath = join(
				modelsDir,
				'ella',
				resolved.ellaModel ?? ELLA_DEFAULTS.ellaModel
			)
			serviceConfig.ellaHfRepo = ELLA_DEFAULTS.ellaHfRepo
			serviceConfig.ellaHfFilename =
				ELLA_DEFAULTS.ellaHfFilename
		}

		onProgress(
			'denoising',
			'started',
			'Starting generation...'
		)

		const serviceResult = await serviceGenerate(
			baseUrl,
			serviceConfig,
			onProgress
		)

		// Upload images
		const batchImages = serviceResult.images
		const mime = 'image/png'
		onProgress(
			'save',
			'started',
			`Saving ${batchImages.length} generated image(s)...`
		)

		const uploadedImages: Array<{
			uploadId: string
			url: string
			mime: string
		}> = []

		for (const img of batchImages) {
			const imageFile = Bun.file(img.imagePath)
			const imageBuffer = Buffer.from(
				await imageFile.arrayBuffer()
			)

			const blobRef = await blobSink.write({
				traceId: runId,
				spanId: 'image-gen',
				role: 'generated_image',
				content: imageBuffer,
				mimeType: mime,
				ext: 'png'
			})

			uploadedImages.push({
				uploadId: blobRef.uploadId,
				url: blobRef.url,
				mime
			})

			// Clean up temp file
			try {
				unlinkSync(img.imagePath)
			} catch {}
		}

		onProgress(
			'save',
			'completed',
			`Saved ${uploadedImages.length} generated image(s)`
		)

		const durationMs = Date.now() - startTime

		// Update seed from Python
		if (serviceResult.seed != null) {
			resolved.seed = serviceResult.seed
		}

		const primaryUpload = uploadedImages[0]

		console.info(
			`[image-gen] Complete: ${uploadedImages.length} image(s) in ${(durationMs / 1000).toFixed(1)}s`
		)

		imageTrace({
			type: 'generation_success',
			sessionId,
			uploadId: primaryUpload.uploadId,
			mime,
			durationMs,
			recipe: resolved as unknown as Record<string, unknown>
		})

		return {
			success: true,
			request: resolved,
			uploadId: primaryUpload.uploadId,
			url: primaryUpload.url,
			mime,
			images: uploadedImages,
			durationMs
		}
	} catch (err) {
		const durationMs = Date.now() - startTime
		imageTrace({
			type: 'generation_failed',
			sessionId,
			error: String(err),
			durationMs,
			recipe: resolved as unknown as Record<string, unknown>
		})

		return {
			success: false,
			request: resolved,
			durationMs,
			error: String(err)
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildEmptyConfig(
	args: GenerateImageRequest,
	model: string
): ResolvedGenerationConfig {
	return {
		prompt: args.prompt,
		negativePrompt:
			args.negativePrompt ?? DEFAULT_NEGATIVE_SD15,
		model,
		checkpoint: '',
		arch: 'sd15',
		seed: args.seed ?? -1,
		steps: args.steps ?? 25,
		cfgScale: args.cfgScale ?? 7,
		sampler: args.sampler ?? 'euler',
		scheduler: args.scheduler ?? 'normal',
		denoise: args.denoise ?? 1.0,
		width: args.width ?? 512,
		height: args.height ?? 512,
		batchSize: args.batchSize ?? 1,
		clipSkip: args.clipSkip ?? 1,
		useADetailer: args.useADetailer ?? false,
		adetailerStrength: args.adetailerStrength ?? 0.4,
		adetailerSteps: args.adetailerSteps ?? 20,
		adetailerConfidence: args.adetailerConfidence ?? 0.3,
		adetailerDetectFaces: args.adetailerDetectFaces ?? true,
		adetailerDetectHands: args.adetailerDetectHands ?? true,
		adetailerMaskPadding: args.adetailerMaskPadding ?? 32,
		adetailerMaskBlur: args.adetailerMaskBlur ?? 12,
		useElla: args.useElla ?? false,
		loras: []
	}
}
