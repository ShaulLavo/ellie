export { ensureDiffusersReady } from './auto-setup'
export type { ProgressFn } from './auto-setup'

export { executeImageGeneration } from './generate-image'
export type {
	GenerateImageRequest,
	ResolvedGenerationConfig,
	GenerationResult,
	GenerationDeps
} from './generate-image'

export {
	MODEL_PRESETS,
	LORA_PRESETS,
	TI_PRESETS
} from './model-registry'

export { imageTrace, initImageTrace } from './image-trace'

export {
	ensureImageGenService,
	stopImageGenService
} from './service-supervisor'
