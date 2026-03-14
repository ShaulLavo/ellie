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

const PARAKEET_MODEL_DIR = join(
	MODELS_DIR,
	'parakeet-tdt-0.6b-v3-int8'
)
const PARAKEET_TAR_URL =
	'https://blob.handy.computer/parakeet-v3-int8.tar.gz'

async function downloadWithProgress(
	url: string,
	dest: string,
	label: string
): Promise<void> {
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok)
		throw new Error(
			`Failed to download ${label}: ${res.status}`
		)

	const total = Number(
		res.headers.get('content-length') || 0
	)
	if (!total || !res.body) {
		await Bun.write(dest, res)
		return
	}

	const file = Bun.file(dest).writer()
	let downloaded = 0
	let lastPct = -1

	for await (const chunk of res.body) {
		file.write(chunk)
		downloaded += chunk.byteLength
		const pct = Math.floor((downloaded / total) * 100)
		if (pct !== lastPct && pct % 10 === 0) {
			const mb = (downloaded / 1_000_000).toFixed(1)
			const totalMb = (total / 1_000_000).toFixed(1)
			process.stdout.write(
				`\r${label}: ${mb}/${totalMb} MB (${pct}%)`
			)
			lastPct = pct
		}
	}

	await file.end()
	process.stdout.write('\n')
}

async function downloadVad() {
	if (existsSync(VAD_MODEL_PATH)) {
		console.log(
			'VAD model already exists, skipping download.'
		)
		return
	}
	console.log('Downloading Silero VAD v4 model...')
	await downloadWithProgress(
		VAD_MODEL_URL,
		VAD_MODEL_PATH,
		'VAD model'
	)
	console.log('VAD model downloaded.')
}

async function downloadParakeet() {
	if (existsSync(PARAKEET_MODEL_DIR)) {
		console.log(
			'Parakeet model already exists, skipping download.'
		)
		return
	}
	console.log(
		'Downloading Parakeet TDT 0.6B v3 int8 model...'
	)

	const tarPath = join(
		MODELS_DIR,
		'parakeet-v3-int8.tar.gz'
	)
	await downloadWithProgress(
		PARAKEET_TAR_URL,
		tarPath,
		'Parakeet model'
	)

	// Extract the tarball
	const proc = Bun.spawn(
		['tar', '-xzf', tarPath, '-C', MODELS_DIR],
		{ stdout: 'inherit', stderr: 'inherit' }
	)
	const exitCode = await proc.exited
	if (exitCode !== 0)
		throw new Error(
			`Failed to extract Parakeet model (exit ${exitCode})`
		)

	// Clean up tarball
	const { unlinkSync } = await import('fs')
	unlinkSync(tarPath)

	// The tarball may extract to a different name — find and rename if needed
	if (!existsSync(PARAKEET_MODEL_DIR)) {
		const { readdirSync, renameSync } = await import('fs')
		const entries = readdirSync(MODELS_DIR)
		const parakeetDir = entries.find(
			e =>
				e.startsWith('parakeet') &&
				e !== 'silero_vad_v4.onnx'
		)
		if (parakeetDir) {
			renameSync(
				join(MODELS_DIR, parakeetDir),
				PARAKEET_MODEL_DIR
			)
		}
	}

	if (!existsSync(PARAKEET_MODEL_DIR)) {
		throw new Error(
			'Parakeet model extraction failed — directory not found after extract'
		)
	}
	console.log('Parakeet model downloaded and extracted.')
}

async function setup() {
	mkdirSync(MODELS_DIR, { recursive: true })
	await downloadVad()
	await downloadParakeet()
}

setup().catch(err => {
	console.error('STT setup failed:', err)
	process.exit(1)
})
