/**
 * Image generation types — shared between server and frontend.
 *
 * Canonical sampler/scheduler identifiers, request shapes, and result metadata.
 * Field names use consistent camelCase throughout.
 */

// ── Samplers ────────────────────────────────────────────────────────────────

/** Canonical sampler identifiers that map to Diffusers scheduler classes. */
export type SamplerName =
	| 'euler'
	| 'euler_ancestral'
	| 'heun'
	| 'dpm_2'
	| 'dpm_2_ancestral'
	| 'lms'
	| 'dpmpp_2s_ancestral'
	| 'dpmpp_sde'
	| 'dpmpp_2m'
	| 'dpmpp_2m_sde'
	| 'ddim'
	| 'uni_pc'

/** All valid sampler names as a runtime array. */
export const SAMPLER_NAMES: SamplerName[] = [
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
]

// ── Schedulers ──────────────────────────────────────────────────────────────

/** Noise schedule variant applied on top of the sampler. */
export type SchedulerName = 'normal' | 'karras'

export const SCHEDULER_NAMES: SchedulerName[] = [
	'normal',
	'karras'
]

// ── Model architecture ──────────────────────────────────────────────────────

export type ModelArch = 'sd15' | 'sdxl'

// ── LoRA reference ──────────────────────────────────────────────────────────

export interface LoraRef {
	name: string
	preset?: string
	strengthModel: number
	strengthClip: number
}

// ── Generation request (user-facing API) ────────────────────────────────────

export interface GenerateImageRequest {
	prompt: string
	negativePrompt?: string
	model?: string
	width?: number
	height?: number
	steps?: number
	cfgScale?: number
	sampler?: SamplerName
	scheduler?: SchedulerName
	denoise?: number
	seed?: number
	batchSize?: number
	useElla?: boolean
	ellaModel?: string
	t5Encoder?: string
	t5MaxLength?: number
	loras?: Array<{
		name: string
		strengthModel?: number
		strengthClip?: number
	}>
}

// ── Resolved generation config (sent to Python worker) ──────────────────────

export interface ResolvedGenerationConfig {
	prompt: string
	negativePrompt: string
	model: string
	checkpoint: string
	arch: ModelArch
	seed: number
	steps: number
	cfgScale: number
	sampler: SamplerName
	scheduler: SchedulerName
	denoise: number
	width: number
	height: number
	batchSize: number
	useElla: boolean
	ellaModel?: string
	t5Encoder?: string
	t5MaxLength?: number
	loras: LoraRef[]
}

// ── Generation result ───────────────────────────────────────────────────────

export interface GeneratedImage {
	uploadId: string
	url: string
	mime: string
}

export interface GenerationResult {
	success: boolean
	request: ResolvedGenerationConfig
	/** @deprecated Use `images` array instead */
	uploadId?: string
	/** @deprecated Use `images` array instead */
	url?: string
	/** @deprecated Use `images` array instead */
	mime?: string
	/** All generated images (length matches batchSize) */
	images?: GeneratedImage[]
	durationMs: number
	error?: string
}

// ── Worker protocol messages ────────────────────────────────────────────────

export type WorkerMessageType =
	| 'init'
	| 'generate'
	| 'health'
	| 'shutdown'

export type WorkerEventType =
	| 'ready'
	| 'progress'
	| 'result'
	| 'error'
	| 'health'
	| 'shutdown_ack'

export interface WorkerProgressEvent {
	event: 'progress'
	phase: string
	message?: string
	step?: number
	totalSteps?: number
	resourceId?: string
	bytesDone?: number
	bytesTotal?: number
}

export interface WorkerResultEvent {
	event: 'result'
	success: true
	imagePath: string
	width: number
	height: number
	seed: number
	images?: Array<{
		imagePath: string
		width: number
		height: number
	}>
}

export interface WorkerErrorEvent {
	event: 'error'
	message: string
	phase?: string
}

export interface WorkerReadyEvent {
	event: 'ready'
	device: string
	dtype: string
	vramMb?: number
}

export interface WorkerHealthEvent {
	event: 'health'
	alive: true
	cachedModels: string[]
	uptimeMs: number
}

export interface WorkerShutdownAckEvent {
	event: 'shutdown_ack'
}

export type WorkerEvent =
	| WorkerProgressEvent
	| WorkerResultEvent
	| WorkerErrorEvent
	| WorkerReadyEvent
	| WorkerHealthEvent
	| WorkerShutdownAckEvent
