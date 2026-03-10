/**
 * generate_image tool — Generate images using Stable Diffusion via ComfyUI.
 *
 * Follows the AgentTool pattern (like shell-tool.ts).
 * Images are stored via BlobSink. Progress flows through the onUpdate callback
 * into tool_execution_update events for real-time UI updates.
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback
} from '@ellie/agent'
import type { BlobSink } from '@ellie/trace'
import {
	executeImageGeneration,
	MODEL_PRESETS,
	type GenerateImageArgs
} from '../../../lib/comfyui'
import type { ProgressFn } from '../../../lib/comfyui'

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
			'Text description of the image to generate. Be specific and detailed. ' +
				"SD 1.5 models respond well to comma-separated tags (e.g. 'portrait of a woman, soft lighting, bokeh, 4k'). " +
				'SDXL handles natural language better. ' +
				'With ELLA enabled, use full natural-language sentences for best results.'
		)
	),
	negative_prompt: v.optional(
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
	use_ella: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Enable ELLA for improved prompt comprehension. Only works with SD 1.5 models. Default: false'
			)
		)
	),
	ella_model: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"ELLA model filename. Default: 'ella-sd1.5-tsc-t5xl.safetensors'"
			)
		)
	),
	t5_encoder: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"T5 text encoder model name. Default: 'flan-t5-xl'"
			)
		)
	),
	t5_max_length: v.optional(
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
	cfg_scale: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Classifier-free guidance scale. 1.0 = ignore prompt. 7.0 = balanced. 15+ = strict.'
			)
		)
	),
	sampler_name: v.optional(
		v.pipe(
			v.picklist([
				'euler',
				'euler_ancestral',
				'heun',
				'heunpp2',
				'dpm_2',
				'dpm_2_ancestral',
				'lms',
				'dpm_fast',
				'dpm_adaptive',
				'dpmpp_2s_ancestral',
				'dpmpp_sde',
				'dpmpp_sde_gpu',
				'dpmpp_2m',
				'dpmpp_2m_sde',
				'dpmpp_2m_sde_gpu',
				'dpmpp_3m_sde',
				'dpmpp_3m_sde_gpu',
				'ddpm',
				'lcm',
				'ddim',
				'uni_pc',
				'uni_pc_bh2'
			]),
			v.description(
				'Sampling algorithm. Each model uses its recommended sampler by default.'
			)
		)
	),
	scheduler: v.optional(
		v.pipe(
			v.picklist([
				'normal',
				'karras',
				'exponential',
				'sgm_uniform',
				'simple',
				'ddim_uniform',
				'beta'
			]),
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
	batch_size: v.optional(
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
					strength_model: v.optional(
						v.pipe(
							v.number(),
							v.description(
								'LoRA influence on model weights. 0.0-1.0. Default: preset default or 1.0'
							)
						)
					),
					strength_clip: v.optional(
						v.pipe(
							v.number(),
							v.description(
								'LoRA influence on CLIP weights. Usually same as strength_model.'
							)
						)
					)
				})
			),
			v.description(
				"LoRAs to apply. Available presets: 'perfection' (fixes anatomy). Multiple can be stacked."
			)
		)
	),
	filename_prefix: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"Prefix for saved filename in ComfyUI. Default: 'ComfyUI'"
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
}

export function createImageGenTool(
	deps: ImageGenToolDeps
): AgentTool {
	return {
		name: 'generate_image',
		description:
			'Generate images using Stable Diffusion via ComfyUI. ' +
			'Returns a complete reproducible recipe (every parameter including seed) with the generated image.\n\n' +
			'QUICK START: Just provide a prompt. Everything else has sensible defaults.\n\n' +
			'MODEL GUIDE:\n' +
			"- Photorealistic people: 'cyberrealistic' + perfection LoRA\n" +
			"- Moody/cinematic: 'moodymix' (dramatic lighting built in)\n" +
			"- General realistic: 'realizum' (warm, natural)\n" +
			"- Artistic/creative: 'perfectdeliberate' (illustration-photo blend)\n" +
			"- High-res/complex scenes: 'sdxl' (1024px, better anatomy, no ELLA)\n" +
			'- Complex prompts needing precise understanding: any SD 1.5 model + use_ella=true\n\n' +
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

			// Progress adapter: preserves the full visible timeline for the UI.
			const progress = createThrottledProgress(onUpdate)

			const result = await executeImageGeneration(
				rawParams as GenerateImageArgs,
				{
					blobSink: deps.blobSink,
					sessionId,
					runId,
					dataDir: deps.dataDir,
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
						recipe: result.recipe,
						entries: progressSnapshot.entries,
						completedPhases:
							progressSnapshot.completedPhases
					}
				}
			}

			// Normalize recipe to web-friendly shape
			const r = result.recipe
			const webRecipe = {
				model: r.model,
				width: r.width,
				height: r.height,
				steps: r.steps,
				cfg: r.cfg_scale,
				seed: r.seed,
				durationMs: result.durationMs,
				loras: r.loras?.map(l => ({
					name: l.name,
					strength: l.strength_model
				}))
			}

			return {
				content: [
					{
						type: 'text',
						text:
							`Image generated successfully.\n` +
							`Model: ${webRecipe.model}\n` +
							`Dimensions: ${webRecipe.width}x${webRecipe.height}\n` +
							`Steps: ${webRecipe.steps}, CFG: ${webRecipe.cfg}\n` +
							`Seed: ${webRecipe.seed}\n` +
							`Duration: ${(result.durationMs / 1000).toFixed(1)}s\n` +
							`The image has been automatically attached to your reply.`
					}
				],
				details: {
					success: true,
					recipe: webRecipe,
					uploadId: result.uploadId,
					url: result.url,
					elapsedMs: result.durationMs,
					entries: progressSnapshot.entries,
					completedPhases: progressSnapshot.completedPhases
				}
			}
		}
	}
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

		// Track completed phases for timeline display
		if (
			status === 'completed' &&
			!completedPhases.includes(phase)
		) {
			completedPhases.push(phase)
		}

		// Throttle denoising running updates to avoid flooding SSE
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
		case 'Auto-setup':
		case 'Downloading models':
		case 'Launching ComfyUI':
		case 'setup':
			return 'setup'
		case 'queue':
			return 'queue'
		case 'denoising':
			return 'denoising'
		case 'fetch':
			return 'fetch'
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
		case 'Auto-setup':
			return 'Auto-setup'
		case 'Downloading models':
			return 'Downloading models'
		case 'Launching ComfyUI':
			return 'Launching ComfyUI'
		case 'queue':
			return 'Queue prompt'
		case 'denoising':
			return 'Generating image'
		case 'fetch':
			return 'Downloading output image'
		case 'save':
			return 'Saving generated image'
		default:
			return label
	}
}
