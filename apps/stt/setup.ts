import { existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'

const MODELS_DIR = resolve(
	import.meta.dirname,
	'../../data/models/stt'
)
const VAD_MODEL_PATH = join(
	MODELS_DIR,
	'silero_vad_v4.onnx'
)
const VAD_MODEL_URL =
	'https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx'

async function setup() {
	mkdirSync(MODELS_DIR, { recursive: true })

	if (!existsSync(VAD_MODEL_PATH)) {
		console.log(
			`Downloading Silero VAD v4 model to ${VAD_MODEL_PATH}...`
		)
		const res = await fetch(VAD_MODEL_URL, {
			redirect: 'follow'
		})
		if (!res.ok)
			throw new Error(
				`Failed to download VAD model: ${res.status}`
			)
		await Bun.write(VAD_MODEL_PATH, res)
		console.log('VAD model downloaded.')
	} else {
		console.log(
			'VAD model already exists, skipping download.'
		)
	}
}

setup().catch(err => {
	console.error('STT setup failed:', err)
	process.exit(1)
})
