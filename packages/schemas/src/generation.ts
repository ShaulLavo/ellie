/**
 * Image generation types — shared between server and frontend.
 */

export type SamplerName =
	| 'euler'
	| 'euler_ancestral'
	| 'heun'
	| 'heunpp2'
	| 'dpm_2'
	| 'dpm_2_ancestral'
	| 'lms'
	| 'dpm_fast'
	| 'dpm_adaptive'
	| 'dpmpp_2s_ancestral'
	| 'dpmpp_sde'
	| 'dpmpp_sde_gpu'
	| 'dpmpp_2m'
	| 'dpmpp_2m_sde'
	| 'dpmpp_2m_sde_gpu'
	| 'dpmpp_3m_sde'
	| 'dpmpp_3m_sde_gpu'
	| 'ddpm'
	| 'lcm'
	| 'ddim'
	| 'uni_pc'
	| 'uni_pc_bh2'

export type SchedulerName =
	| 'normal'
	| 'karras'
	| 'exponential'
	| 'sgm_uniform'
	| 'simple'
	| 'ddim_uniform'
	| 'beta'

export interface ImageGenerationBase {
	prompt: string
	negative_prompt: string
	model: string
	seed: number
	steps: number
	cfg_scale: number
	sampler_name: SamplerName
	scheduler: SchedulerName
	denoise: number
	width: number
	height: number
	batch_size: number
	ella: boolean
	ella_model?: string
	t5_encoder?: string
	t5_max_length?: number
	loras: Array<{
		name: string
		preset?: string
		strength_model: number
		strength_clip: number
	}>
}
