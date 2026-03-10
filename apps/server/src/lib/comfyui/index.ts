export { ComfyUIClient } from './client'
export type {
	ComfyUIClientConfig,
	ProgressCallback
} from './client'

export {
	ensureComfyReady,
	downloadRemainingModelsInBackground
} from './auto-setup'
export type {
	AutoSetupOptions,
	AutoSetupResult,
	ProgressFn
} from './auto-setup'

export { executeImageGeneration } from './generate-image'
export type {
	GenerateImageArgs,
	ImageRecipe,
	GenerationResult,
	GenerationDeps
} from './generate-image'

export {
	MODEL_PRESETS,
	LORA_PRESETS
} from './workflows/txt2img'

export { imageTrace, initImageTrace } from './image-trace'
