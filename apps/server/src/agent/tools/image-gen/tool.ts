/**
 * generate_image tool — Generate images using Stable Diffusion via Diffusers.
 *
 * Follows the AgentTool pattern (like shell-tool.ts).
 * Images are stored via BlobSink. Progress flows through the onUpdate callback
 * into tool_execution_update events for real-time UI updates.
 */

import * as v from 'valibot'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback
} from '@ellie/agent'
import type { BlobSink } from '@ellie/trace'
import { loadCivitaiCredential } from '@ellie/ai/credentials'
import {
	executeImageGeneration,
	MODEL_PRESETS,
	type GenerateImageRequest,
	type ProgressFn
} from '@ellie/image-gen'

// ── Schema ──────────────────────────────────────────────────────────────

const modelKeys = Object.keys(MODEL_PRESETS) as [
	string,
	...string[]
]

const modelDescription =
	'Checkpoint model to use. Each has different strengths:\n' +
	Object.entries(MODEL_PRESETS)
		.map(
			([key, preset]) =>
				`  '${key}' — ${preset.description}`
		)
		.join('\n') +
	'\nDefault: sd15'

const imageGenParams = v.object({
	prompt: v.pipe(
		v.string(),
		v.description(
			'Text description of the image to generate. Be specific and detailed.\n' +
				'SD 1.5 PROMPTING: Use comma-separated tags with photographic terms for best results. ' +
				"Include: subject, camera (e.g. 'nikon d850, 85mm, f1.6'), film stock (e.g. 'kodak portra 400, cinestill 800'), " +
				"lighting (e.g. 'dramatic lighting, rimlight, three point studio light, golden hour'), " +
				"and quality tokens (e.g. 'rich colors, hyper realistic, lifelike texture, film grain').\n" +
				'SDXL handles natural language better.\n' +
				'With ELLA enabled, use full natural-language sentences for best results.'
		)
	),
	negativePrompt: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'What to avoid in the image. Each model has a comprehensive default. ' +
					'Override only to add model/scene-specific exclusions.'
			)
		)
	),
	model: v.optional(
		v.pipe(
			v.picklist(modelKeys),
			v.description(modelDescription)
		)
	),
	useElla: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Enable ELLA for improved prompt comprehension. Only works with SD 1.5 models. Default: false'
			)
		)
	),
	ellaModel: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"ELLA model filename. Default: 'ella-sd1.5-tsc-t5xl.safetensors'"
			)
		)
	),
	t5Encoder: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"T5 text encoder model name. Default: 'flan-t5-xl'"
			)
		)
	),
	t5MaxLength: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Max token length for T5 encoder. Default: 128'
			)
		)
	),
	width: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Image width in pixels. Must be divisible by 8. SD 1.5 default: 512. SDXL default: 1024.'
			)
		)
	),
	height: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Image height in pixels. Must be divisible by 8. SD 1.5 default: 512. SDXL default: 1024.'
			)
		)
	),
	steps: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Number of denoising steps. More steps = more detail but slower. Recommended: 20-30.'
			)
		)
	),
	cfgScale: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Classifier-free guidance scale. 1.0 = ignore prompt. 7.0 = balanced. 15+ = strict.'
			)
		)
	),
	sampler: v.optional(
		v.pipe(
			v.picklist([
				'euler',
				'euler_ancestral',
				'heun',
				'dpm_2',
				'dpm_2_ancestral',
				'lms',
				'dpmpp_2s_ancestral',
				'dpmpp_sde',
				'dpmpp_2m',
				'dpmpp_2m_sde',
				'ddim',
				'uni_pc'
			]),
			v.description(
				'Sampling algorithm. Each model uses its recommended sampler by default.'
			)
		)
	),
	scheduler: v.optional(
		v.pipe(
			v.picklist(['normal', 'karras']),
			v.description(
				"Noise schedule. 'normal' = default, 'karras' = generally better quality."
			)
		)
	),
	denoise: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Denoising strength (0.0 to 1.0). For txt2img, always 1.0. Default: 1.0'
			)
		)
	),
	seed: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Random seed for reproducibility. -1 or omit for random.'
			)
		)
	),
	batchSize: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Number of images to generate in one batch. Default: 1.'
			)
		)
	),
	loras: v.optional(
		v.pipe(
			v.array(
				v.object({
					name: v.pipe(
						v.string(),
						v.description(
							"LoRA name — use a preset name ('perfection') or full filename."
						)
					),
					strengthModel: v.optional(
						v.pipe(
							v.number(),
							v.description(
								'LoRA influence on model weights. 0.0-1.0. Default: preset default or 1.0'
							)
						)
					),
					strengthClip: v.optional(
						v.pipe(
							v.number(),
							v.description(
								'LoRA influence on CLIP weights. Usually same as strengthModel.'
							)
						)
					)
				})
			),
			v.description(
				"LoRAs to apply. Available presets: 'perfection' (fixes anatomy). Multiple can be stacked."
			)
		)
	)
})

// ── Factory ─────────────────────────────────────────────────────────────

export interface ImageGenToolDeps {
	blobSink: BlobSink
	dataDir: string
	getSessionId: () => string | null
	getRunId: () => string | null
	credentialsPath?: string
}

export function createImageGenTool(
	deps: ImageGenToolDeps
): AgentTool {
	return {
		name: 'generate_image',
		description:
			'Generate images using Stable Diffusion via Diffusers. ' +
			'Returns a complete reproducible recipe (every parameter including seed) with the generated image.\n\n' +
			'QUICK START: Just provide a prompt. Everything else has sensible defaults.\n\n' +
			'MODEL GUIDE:\n' +
			"- Photorealistic people: 'cyberrealistic' + perfection LoRA\n" +
			"- Moody/cinematic: 'moodymix' (dramatic lighting built in)\n" +
			"- General realistic: 'realizum' (warm, natural)\n" +
			"- Artistic/creative: 'perfectdeliberate' (illustration-photo blend)\n" +
			"- High-res/complex scenes: 'sdxl' (1024px, better anatomy, no ELLA)\n" +
			'- Complex prompts needing precise understanding: any SD 1.5 model + useElla=true\n\n' +
			'SD 1.5 PHOTOREALISM TIPS:\n' +
			'- Use photographic terms: camera model/lens (nikon d850, 85mm, f1.6), film stock (kodak portra 400, cinestill 800)\n' +
			'- Include lighting: dramatic lighting, rimlight, three point studio light, golden hour\n' +
			'- Quality tokens: rich colors, hyper realistic, lifelike texture, film grain, sharp focus\n' +
			"- Best samplers for photorealism: dpmpp_2m_sde or dpmpp_sde with scheduler 'karras'\n" +
			'- Use 25-30 steps minimum, cfgScale 5-7 for realistic models\n\n' +
			'REPRODUCIBILITY: Every generation returns a full recipe with seed. ' +
			'To recreate exactly: use the same seed and all returned parameters.',
		label: 'Generating image',
		parameters: imageGenParams,
		execute: async (
			_toolCallId,
			rawParams,
			_signal,
			onUpdate
		): Promise<AgentToolResult> => {
			const sessionId = deps.getSessionId()
			const runId = deps.getRunId()
			if (!sessionId || !runId) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: No active session or run'
						}
					],
					details: { success: false }
				}
			}

			const progress = createThrottledProgress(onUpdate)

			let civitaiToken = process.env.CIVITAI_TOKEN
			if (!civitaiToken && deps.credentialsPath) {
				const cred = await loadCivitaiCredential(
					deps.credentialsPath
				)
				if (cred) civitaiToken = cred.key
			}

			const result = await executeImageGeneration(
				rawParams as GenerateImageRequest,
				{
					blobSink: deps.blobSink,
					sessionId,
					runId,
					dataDir: deps.dataDir,
					civitaiToken,
					onProgress: progress.onProgress
				}
			)
			const progressSnapshot = progress.getSnapshot()

			if (!result.success) {
				return {
					content: [
						{
							type: 'text',
							text: `Image generation failed: ${result.error}`
						}
					],
					details: {
						success: false,
						error: result.error,
						recipe: result.request,
						entries: progressSnapshot.entries,
						completedPhases:
							progressSnapshot.completedPhases
					}
				}
			}

			const r = result.request
			const webRecipe = {
				model: r.model,
				width: r.width,
				height: r.height,
				steps: r.steps,
				cfg: r.cfgScale,
				seed: r.seed,
				durationMs: result.durationMs,
				loras: r.loras?.map(l => ({
					name: l.name,
					strength: l.strengthModel
				}))
			}

			const imageCount = result.images?.length ?? 1
			const uploadIds =
				result.images?.map(i => i.uploadId) ??
				(result.uploadId ? [result.uploadId] : [])
			const imageParts = loadToolResultImages(
				uploadIds,
				deps.dataDir,
				result.images?.[0]?.mime ??
					result.mime ??
					'image/png'
			)

			return {
				content: [
					{
						type: 'text',
						text:
							`${imageCount} image(s) generated successfully.\n` +
							`Model: ${webRecipe.model}\n` +
							`Dimensions: ${webRecipe.width}x${webRecipe.height}\n` +
							`Steps: ${webRecipe.steps}, CFG: ${webRecipe.cfg}\n` +
							`Seed: ${webRecipe.seed}\n` +
							`Duration: ${(result.durationMs / 1000).toFixed(1)}s\n` +
							`Upload IDs: ${uploadIds.join(', ')}\n` +
							`The image(s) have been saved and will be automatically included in your reply.`
					},
					...imageParts
				],
				details: {
					success: true,
					recipe: webRecipe,
					uploadId: result.uploadId,
					url: result.url,
					images: result.images,
					elapsedMs: result.durationMs,
					entries: progressSnapshot.entries,
					completedPhases: progressSnapshot.completedPhases
				}
			}
		}
	}
}

function loadToolResultImages(
	uploadIds: string[],
	dataDir: string,
	defaultMimeType: string
): Array<{
	type: 'image'
	data: string
	mimeType: string
}> {
	const imageParts: Array<{
		type: 'image'
		data: string
		mimeType: string
	}> = []

	for (const uploadId of uploadIds) {
		const filePath = join(dataDir, 'uploads', uploadId)

		try {
			const bytes = readFileSync(filePath)
			imageParts.push({
				type: 'image',
				data: bytes.toString('base64'),
				mimeType: defaultMimeType
			})
		} catch (error) {
			console.warn(
				`[image-gen] failed to load generated image for tool result: ${uploadId}`,
				error
			)
		}
	}

	return imageParts
}

// ── Progress adapter ─────────────────────────────────────────────────

const DENOISING_THROTTLE_MS = 500

type ImageProgressStatus =
	| 'started'
	| 'running'
	| 'completed'
	| 'failed'

interface ImageProgressEntry {
	id: string
	phase: string
	label: string
	status: ImageProgressStatus
	detail?: string
	step?: number
	totalSteps?: number
}

interface ImageProgressTracker {
	onProgress?: ProgressFn
	getSnapshot: () => {
		entries: ImageProgressEntry[]
		completedPhases: string[]
	}
}

function createThrottledProgress(
	onUpdate?: AgentToolUpdateCallback
): ImageProgressTracker {
	if (!onUpdate) {
		return {
			onProgress: undefined,
			getSnapshot: () => ({
				entries: [],
				completedPhases: []
			})
		}
	}

	let lastDenoisingUpdate = 0
	const completedPhases: string[] = []
	const entries: ImageProgressEntry[] = []
	let entryCounter = 0

	const onProgress: ProgressFn = (
		label,
		status,
		detail,
		step,
		totalSteps
	) => {
		const phase = mapProgressPhase(label)

		if (
			status === 'completed' &&
			!completedPhases.includes(phase)
		) {
			completedPhases.push(phase)
		}

		if (label === 'denoising' && status === 'running') {
			const now = Date.now()
			if (now - lastDenoisingUpdate < DENOISING_THROTTLE_MS)
				return
			lastDenoisingUpdate = now
		}

		recordProgressEntry(entries, {
			label,
			phase,
			status,
			detail,
			step,
			totalSteps,
			nextId: () => `image-progress-${++entryCounter}`
		})

		onUpdate({
			content: [
				{
					type: 'text',
					text: `${label}: ${status}`
				}
			],
			details: {
				phase,
				status,
				detail,
				step,
				totalSteps,
				completedPhases: [...completedPhases],
				entries: [...entries]
			}
		})
	}

	return {
		onProgress,
		getSnapshot: () => ({
			entries: [...entries],
			completedPhases: [...completedPhases]
		})
	}
}

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

function recordProgressEntry(
	entries: ImageProgressEntry[],
	update: {
		label: string
		phase: string
		status: ImageProgressStatus
		detail?: string
		step?: number
		totalSteps?: number
		nextId: () => string
	}
): void {
	const {
		label,
		phase,
		status,
		detail,
		step,
		totalSteps,
		nextId
	} = update

	if (
		!shouldShowProgressEntry(
			label,
			detail,
			step,
			totalSteps
		)
	) {
		return
	}

	const normalizedLabel = formatProgressLabel(label)
	const lastEntry = entries.at(-1)
	const shouldUpdateLast =
		label === 'denoising' &&
		status === 'running' &&
		lastEntry?.label === normalizedLabel

	if (shouldUpdateLast && lastEntry) {
		lastEntry.status = status
		lastEntry.detail = detail
		lastEntry.step = step
		lastEntry.totalSteps = totalSteps
		return
	}

	if (
		lastEntry &&
		lastEntry.label === normalizedLabel &&
		lastEntry.status === status &&
		lastEntry.detail === detail &&
		lastEntry.step === step &&
		lastEntry.totalSteps === totalSteps
	) {
		return
	}

	entries.push({
		id: nextId(),
		phase,
		label: normalizedLabel,
		status,
		detail,
		step,
		totalSteps
	})
}

function shouldShowProgressEntry(
	label: string,
	detail?: string,
	step?: number,
	totalSteps?: number
): boolean {
	if (detail) return true
	if (label === 'denoising') return true
	return step != null && totalSteps != null
}

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
