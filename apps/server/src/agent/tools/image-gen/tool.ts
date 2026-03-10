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

			// Throttled progress adapter: bridges ProgressFn → onUpdate
			const onProgress = createThrottledProgress(onUpdate)

			const result = await executeImageGeneration(
				rawParams as GenerateImageArgs,
				{
					blobSink: deps.blobSink,
					sessionId,
					runId,
					dataDir: deps.dataDir,
					onProgress
				}
			)

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
						recipe: result.recipe
					}
				}
			}

			return {
				content: [
					{
						type: 'text',
						text:
							`Image generated successfully.\n` +
							`Model: ${result.recipe.model}\n` +
							`Dimensions: ${result.recipe.width}x${result.recipe.height}\n` +
							`Steps: ${result.recipe.steps}, CFG: ${result.recipe.cfg_scale}\n` +
							`Seed: ${result.recipe.seed}\n` +
							`Duration: ${(result.durationMs / 1000).toFixed(1)}s\n` +
							`The image has been automatically attached to your reply.`
					}
				],
				details: {
					success: true,
					recipe: result.recipe,
					uploadId: result.uploadId,
					filePath: result.filePath,
					durationMs: result.durationMs
				}
			}
		}
	}
}

// ── Progress adapter ─────────────────────────────────────────────────

const DENOISING_THROTTLE_MS = 500

function createThrottledProgress(
	onUpdate?: AgentToolUpdateCallback
): ProgressFn | undefined {
	if (!onUpdate) return undefined

	let lastDenoisingUpdate = 0
	const completedPhases: string[] = []

	return (label, status, detail, step, totalSteps) => {
		// Track completed phases for timeline display
		if (
			status === 'completed' &&
			!completedPhases.includes(label)
		) {
			completedPhases.push(label)
		}

		// Throttle denoising running updates to avoid flooding SSE
		if (label === 'denoising' && status === 'running') {
			const now = Date.now()
			if (now - lastDenoisingUpdate < DENOISING_THROTTLE_MS)
				return
			lastDenoisingUpdate = now
		}

		onUpdate({
			content: [
				{
					type: 'text',
					text: `${label}: ${status}`
				}
			],
			details: {
				phase: label,
				status,
				detail,
				step,
				totalSteps,
				completedPhases: [...completedPhases]
			}
		})
	}
}
