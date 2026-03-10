/**
 * Auto-setup for ComfyUI: ensures ComfyUI is installed, running,
 * and has the specific model files needed for a generation request.
 *
 * Called from generate_image — makes image generation zero-config.
 */

import {
	cp,
	mkdir,
	readdir,
	rename,
	rm
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ComfyUIClient } from './client'
import {
	CHECKPOINTS,
	LORAS,
	ELLA_MODELS,
	run,
	commandExists,
	getComfyWorkspace,
	fileExistsInWorkspace,
	findPython,
	installPython,
	installComfyCli,
	fixPythonSslCerts,
	detectGpuType,
	gpuFlag,
	isWorkspaceHealthy,
	PREFERRED_PYTHON_VERSION
} from './setup-runner'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoSetupOptions {
	/** Checkpoint filename needed */
	checkpoint: string
	/** LoRA filenames needed (already resolved from presets) */
	loraFilenames: string[]
	/** Whether ELLA is needed for this generation */
	needsElla: boolean
	/** CivitAI API token for gated models */
	civitaiToken?: string
	/** Progress callback for reporting setup status */
	onProgress?: ProgressFn
}

export interface AutoSetupResult {
	ready: boolean
	installed: string[]
	skipped: string[]
	failed: string[]
	error?: string
}

export type ProgressFn = (
	label: string,
	status: 'started' | 'running' | 'completed' | 'failed',
	detail?: string,
	step?: number,
	totalSteps?: number
) => void

// ── Mutex ────────────────────────────────────────────────────────────────────

let setupLock: Promise<void> = Promise.resolve()

function acquireLock(): Promise<() => void> {
	let release: () => void
	const prev = setupLock
	setupLock = new Promise(r => {
		release = r
	})
	return prev.then(() => release!)
}

// ── Launch + wait ────────────────────────────────────────────────────────────

async function launchAndWait(
	client: ComfyUIClient,
	progress: ProgressFn
): Promise<boolean> {
	progress(
		'Launching ComfyUI',
		'running',
		'Starting background server...'
	)

	const gpu = await detectGpuType()
	const launchArgs = ['comfy', 'launch', '--background']
	if (gpu === 'm-series') {
		launchArgs.push('--', '--force-fp32')
	}

	const result = await run(launchArgs)
	if (!result.ok) {
		progress(
			'Launching ComfyUI',
			'failed',
			`Launch failed: ${result.stderr.slice(0, 200)}`
		)
		return false
	}

	const maxWaitMs = 10 * 60_000
	const start = Date.now()
	let delay = 1000
	let lastProcessCheck = 0

	while (Date.now() - start < maxWaitMs) {
		await new Promise(r => setTimeout(r, delay))
		const available = await client.isAvailable()
		if (available) {
			progress(
				'Launching ComfyUI',
				'running',
				'Server is ready'
			)
			return true
		}

		const now = Date.now()
		if (now - lastProcessCheck > 15_000) {
			lastProcessCheck = now
			const ps = await run([
				'pgrep',
				'-f',
				'main.py.*ComfyUI'
			])
			if (!ps.ok || !ps.stdout.trim()) {
				progress(
					'Launching ComfyUI',
					'failed',
					'ComfyUI process crashed before becoming ready'
				)
				return false
			}
		}

		delay = Math.min(delay * 1.5, 5000)
		const elapsed = Math.round((Date.now() - start) / 1000)
		progress(
			'Launching ComfyUI',
			'running',
			`Waiting for server... (${elapsed}s)`
		)
	}

	progress(
		'Launching ComfyUI',
		'failed',
		'Server did not start within 10 minutes'
	)
	return false
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function ensureComfyReady(
	client: ComfyUIClient,
	opts: AutoSetupOptions
): Promise<AutoSetupResult> {
	const release = await acquireLock()
	try {
		return await doEnsureComfyReady(client, opts)
	} finally {
		release()
	}
}

const noop: ProgressFn = () => {}
const MODEL_DOWNLOAD_MAX_ATTEMPTS = 3
const MODEL_DOWNLOAD_RETRY_DELAY_MS = 3000

async function doEnsureComfyReady(
	client: ComfyUIClient,
	opts: AutoSetupOptions
): Promise<AutoSetupResult> {
	const progress = opts.onProgress ?? noop

	const installed: string[] = []
	const skipped: string[] = []
	const failed: string[] = []

	const isRunning = await client.isAvailable()

	if (isRunning) {
		const workspace = await getComfyWorkspace()
		if (!workspace) {
			return {
				ready: true,
				installed,
				skipped,
				failed
			}
		}

		const result = await ensureModels(
			workspace,
			opts,
			progress,
			installed,
			skipped,
			failed
		)
		if (!result) {
			return {
				ready: false,
				installed,
				skipped,
				failed,
				error: buildModelFailureMessage(
					failed,
					'Required checkpoint download failed'
				)
			}
		}

		if (installed.length > 0) {
			progress(
				'Setup',
				'completed',
				'Missing models downloaded'
			)
		}
		return { ready: true, installed, skipped, failed }
	}

	// ── Full setup path ────────────────────────────────────────────────

	const neededCheckpoint = CHECKPOINTS.find(
		c => c.filename === opts.checkpoint
	)
	const neededLoras = opts.loraFilenames
		.map((f: string) => LORAS.find(l => l.filename === f))
		.filter(Boolean)
	const downloadCount =
		(neededCheckpoint ? 1 : 0) +
		neededLoras.length +
		(opts.needsElla ? ELLA_MODELS.length + 1 : 0)
	const totalSteps =
		3 + downloadCount + (opts.needsElla ? 1 : 0) + 1
	let step = 0

	const stepProgress = (
		label: string,
		status: 'started' | 'running' | 'completed' | 'failed',
		detail?: string
	) => {
		progress(label, status, detail, step, totalSteps)
	}

	// ── Prerequisites: Python 3.10+ ──────────────────────────────────
	stepProgress(
		'Auto-setup',
		'running',
		'Checking Python...'
	)
	let py = await findPython()
	if (!py) {
		stepProgress(
			'Auto-setup',
			'running',
			`Python 3.10+ not found, installing Python ${PREFERRED_PYTHON_VERSION}...`
		)
		py = await installPython()
		if (!py) {
			stepProgress(
				'Auto-setup',
				'failed',
				'Python 3.10+ not found and auto-install failed'
			)
			return {
				ready: false,
				installed,
				skipped,
				failed,
				error: `Python 3.10+ is required. Install: brew install python@${PREFERRED_PYTHON_VERSION} (macOS) or sudo apt install python3 (Ubuntu)`
			}
		}
		installed.push(`Python ${py.versionStr}`)
	}
	step++
	stepProgress(
		'Auto-setup',
		'running',
		`Python ${py.versionStr} (${py.python})`
	)

	// ── Install comfy-cli ──────────────────────────────────────────────
	const hasComfy = await commandExists('comfy')
	if (hasComfy) {
		skipped.push('comfy-cli')
		step++
		stepProgress(
			'Auto-setup',
			'running',
			'comfy-cli already installed'
		)
	} else {
		stepProgress(
			'Auto-setup',
			'running',
			`Installing comfy-cli via ${py.python}...`
		)
		const ok = await installComfyCli(py)
		if (!ok) {
			stepProgress(
				'Auto-setup',
				'failed',
				'pip install comfy-cli failed'
			)
			return {
				ready: false,
				installed,
				skipped,
				failed,
				error: `Failed to install comfy-cli. Try: ${py.python} -m pip install comfy-cli`
			}
		}
		installed.push('comfy-cli')
		step++
		stepProgress(
			'Auto-setup',
			'running',
			'comfy-cli installed'
		)
	}

	// ── Fix SSL certs ────────────────────────────────────────────────
	stepProgress(
		'Auto-setup',
		'running',
		'Fixing SSL certificates...'
	)
	await fixPythonSslCerts(py)

	// ── Detect GPU type ────────────────────────────────────────────────
	const gpu = await detectGpuType()
	stepProgress(
		'Auto-setup',
		'running',
		`Detected GPU: ${gpu}`
	)

	// ── Install ComfyUI ────────────────────────────────────────────────
	let workspace = await getComfyWorkspace()
	let preservedModelsPath: string | null = null

	if (workspace) {
		const healthy = await isWorkspaceHealthy(workspace)
		if (!healthy) {
			stepProgress(
				'Auto-setup',
				'running',
				'ComfyUI install is broken (missing deps), reinstalling...'
			)
			preservedModelsPath = await preserveWorkspaceModels(
				workspace,
				stepProgress
			)
			await run(['rm', '-rf', workspace])
			workspace = null
		}
	}

	if (workspace) {
		skipped.push('ComfyUI')
		step++
		stepProgress(
			'Auto-setup',
			'running',
			'ComfyUI already installed'
		)
	} else {
		stepProgress(
			'Auto-setup',
			'running',
			'Installing ComfyUI (this takes a few minutes)...'
		)
		const result = await run(
			['comfy', 'install', gpuFlag(gpu), '--fast-deps'],
			{ stdin: 'y\n' }
		)
		if (!result.ok) {
			stepProgress(
				'Auto-setup',
				'failed',
				'ComfyUI install failed'
			)
			return {
				ready: false,
				installed,
				skipped,
				failed,
				error: `ComfyUI installation failed: ${result.stderr.slice(0, 500)}`
			}
		}
		workspace = await getComfyWorkspace()
		if (!workspace) {
			stepProgress(
				'Auto-setup',
				'failed',
				'Could not find workspace'
			)
			return {
				ready: false,
				installed,
				skipped,
				failed,
				error:
					'ComfyUI installed but workspace path not found'
			}
		}
		installed.push('ComfyUI')
		step++
		stepProgress(
			'Auto-setup',
			'running',
			`ComfyUI installed at ${workspace}`
		)
		await restoreWorkspaceModels(
			workspace,
			preservedModelsPath,
			stepProgress
		)
	}

	// ── Download required models ─────────────────────────────────────
	const modelsOk = await ensureModels(
		workspace,
		opts,
		(label, status, detail) => {
			stepProgress(label, status, detail)
			if (
				status === 'running' &&
				detail?.endsWith('— done')
			)
				step++
			if (
				status === 'running' &&
				detail?.endsWith('— already exists')
			)
				step++
			if (
				status === 'running' &&
				detail?.includes('— FAILED')
			)
				step++
		},
		installed,
		skipped,
		failed
	)

	if (!modelsOk) {
		stepProgress(
			'Auto-setup',
			'failed',
			'Required checkpoint download failed'
		)
		return {
			ready: false,
			installed,
			skipped,
			failed,
			error: buildModelFailureMessage(
				failed,
				'Required checkpoint download failed'
			)
		}
	}

	// ── Launch ComfyUI ────────────────────────────────────────────────
	step++
	stepProgress(
		'Auto-setup',
		'running',
		'Launching ComfyUI...'
	)

	const launched = await launchAndWait(client, progress)
	if (!launched) {
		return {
			ready: false,
			installed,
			skipped,
			failed,
			error: 'ComfyUI failed to start within 10 minutes'
		}
	}

	step++
	stepProgress(
		'Auto-setup',
		'completed',
		'ComfyUI is ready'
	)

	return { ready: true, installed, skipped, failed }
}

export function summarizeDownloadError(
	stdout: string,
	stderr: string
): string {
	return (stderr || stdout).slice(-200).trim()
}

export function isRetryableDownloadError(
	detail: string
): boolean {
	const lower = detail.toLowerCase()
	return (
		lower.includes('readtimeout') ||
		lower.includes('timed out') ||
		lower.includes('connection reset') ||
		lower.includes('temporarily unavailable') ||
		lower.includes('connection aborted') ||
		lower.includes('remote disconnected')
	)
}

async function downloadModelWithRetry(
	args: string[],
	progress: ProgressFn,
	label: string,
	modelName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	let lastError = 'download failed'

	for (
		let attempt = 1;
		attempt <= MODEL_DOWNLOAD_MAX_ATTEMPTS;
		attempt++
	) {
		const result = await run(args, { stdin: '\n' })
		if (result.ok) {
			return { ok: true }
		}

		lastError = summarizeDownloadError(
			result.stdout,
			result.stderr
		)
		const canRetry =
			attempt < MODEL_DOWNLOAD_MAX_ATTEMPTS &&
			isRetryableDownloadError(lastError)

		if (!canRetry) {
			return { ok: false, error: lastError }
		}

		progress(
			label,
			'running',
			`${modelName} — download timed out, retrying (${attempt + 1}/${MODEL_DOWNLOAD_MAX_ATTEMPTS})...`
		)
		await Bun.sleep(MODEL_DOWNLOAD_RETRY_DELAY_MS * attempt)
	}

	return { ok: false, error: lastError }
}

function buildModelFailureMessage(
	failed: string[],
	fallback: string
): string {
	const lastFailure = failed.at(-1)
	if (!lastFailure) return fallback
	return `${fallback}: ${lastFailure}`
}

async function preserveWorkspaceModels(
	workspace: string,
	progress: ProgressFn
): Promise<string | null> {
	const modelsPath = join(workspace, 'models')
	const hasModels = await Bun.file(modelsPath).exists()
	if (!hasModels) return null

	const backupPath = `${workspace}.__models_backup__`
	await rm(backupPath, { force: true, recursive: true })
	await rename(modelsPath, backupPath)
	progress(
		'Auto-setup',
		'running',
		'Preserved existing models before repair'
	)
	return backupPath
}

async function restoreWorkspaceModels(
	workspace: string,
	backupPath: string | null,
	progress: ProgressFn
): Promise<void> {
	if (!backupPath) return
	const backupExists = await Bun.file(backupPath).exists()
	if (!backupExists) return

	const modelsPath = join(workspace, 'models')
	const hasModels = await Bun.file(modelsPath).exists()

	if (!hasModels) {
		await rename(backupPath, modelsPath)
		progress(
			'Auto-setup',
			'running',
			'Restored preserved models after repair'
		)
		return
	}

	const existingEntries = await readdir(modelsPath)
	if (existingEntries.length === 0) {
		await rm(modelsPath, { force: true, recursive: true })
		await rename(backupPath, modelsPath)
		progress(
			'Auto-setup',
			'running',
			'Restored preserved models after repair'
		)
		return
	}

	await mkdir(modelsPath, { recursive: true })
	await cp(backupPath, modelsPath, {
		force: false,
		recursive: true
	})
	await rm(backupPath, { force: true, recursive: true })
	progress(
		'Auto-setup',
		'running',
		'Merged preserved models into repaired workspace'
	)
}

// ── Model download logic ─────────────────────────────────────────────────────

async function ensureModels(
	workspace: string,
	opts: AutoSetupOptions,
	progress: ProgressFn,
	installed: string[],
	skipped: string[],
	failed: string[]
): Promise<boolean> {
	const {
		checkpoint,
		loraFilenames,
		needsElla,
		civitaiToken
	} = opts

	// ── Checkpoint ────────────────────────────────────────────────────
	const ckptEntry = CHECKPOINTS.find(
		c => c.filename === checkpoint
	)
	if (ckptEntry) {
		const exists = await fileExistsInWorkspace(
			workspace,
			`${ckptEntry.dest}/${ckptEntry.filename}`
		)
		if (exists) {
			skipped.push(ckptEntry.name)
			progress(
				'Downloading models',
				'running',
				`${ckptEntry.name} — already exists`
			)
		} else {
			progress(
				'Downloading models',
				'running',
				`Downloading ${ckptEntry.name}...`
			)
			const args = [
				'comfy',
				'model',
				'download',
				'--url',
				ckptEntry.url,
				'--relative-path',
				ckptEntry.dest
			]
			if (
				civitaiToken &&
				ckptEntry.url.includes('civitai.com')
			) {
				args.push('--set-civitai-api-token', civitaiToken)
			}
			const result = await downloadModelWithRetry(
				args,
				progress,
				'Downloading models',
				ckptEntry.name
			)
			if (!result.ok) {
				failed.push(ckptEntry.name)
				progress(
					'Downloading models',
					'running',
					`${ckptEntry.name} — FAILED: ${result.error}`
				)
				return false
			}
			installed.push(ckptEntry.name)
			progress(
				'Downloading models',
				'running',
				`${ckptEntry.name} — done`
			)
		}
	}

	// ── LoRAs ────────────────────────────────────────────────────────
	for (const filename of loraFilenames) {
		const loraEntry = LORAS.find(
			l => l.filename === filename
		)
		if (!loraEntry) continue

		const exists = await fileExistsInWorkspace(
			workspace,
			`${loraEntry.dest}/${loraEntry.filename}`
		)
		if (exists) {
			skipped.push(loraEntry.name)
			progress(
				'Downloading LoRAs',
				'running',
				`${loraEntry.name} — already exists`
			)
			continue
		}

		progress(
			'Downloading LoRAs',
			'running',
			`Downloading ${loraEntry.name}...`
		)
		const args = [
			'comfy',
			'model',
			'download',
			'--url',
			loraEntry.url,
			'--relative-path',
			loraEntry.dest
		]
		if (
			civitaiToken &&
			loraEntry.url.includes('civitai.com')
		) {
			args.push('--set-civitai-api-token', civitaiToken)
		}
		const result = await downloadModelWithRetry(
			args,
			progress,
			'Downloading LoRAs',
			loraEntry.name
		)
		if (!result.ok) {
			failed.push(loraEntry.name)
			progress(
				'Downloading LoRAs',
				'running',
				`${loraEntry.name} — FAILED: ${result.error}`
			)
		} else {
			installed.push(loraEntry.name)
			progress(
				'Downloading LoRAs',
				'running',
				`${loraEntry.name} — done`
			)
		}
	}

	// ── ELLA ────────────────────────────────────────────────────────
	if (needsElla) {
		progress(
			'Installing ELLA',
			'running',
			'Installing ComfyUI-ELLA node...'
		)
		const nodeResult = await run([
			'comfy',
			'node',
			'install',
			'ComfyUI-ELLA'
		])
		if (!nodeResult.ok) {
			const errDetail = (
				nodeResult.stderr || nodeResult.stdout
			)
				.slice(-200)
				.trim()
			failed.push('ComfyUI-ELLA node')
			progress(
				'Installing ELLA',
				'running',
				`ComfyUI-ELLA node — FAILED: ${errDetail}`
			)
		} else {
			installed.push('ComfyUI-ELLA node')
			progress(
				'Installing ELLA',
				'running',
				'ComfyUI-ELLA node — done'
			)
		}

		for (const model of ELLA_MODELS) {
			const exists = await fileExistsInWorkspace(
				workspace,
				`${model.dest}/${model.filename}`
			)
			if (exists) {
				skipped.push(model.name)
				progress(
					'Installing ELLA',
					'running',
					`${model.name} — already exists`
				)
				continue
			}

			progress(
				'Installing ELLA',
				'running',
				`Downloading ${model.name}...`
			)
			const retried = await downloadModelWithRetry(
				[
					'comfy',
					'model',
					'download',
					'--url',
					model.url,
					'--relative-path',
					model.dest
				],
				progress,
				'Installing ELLA',
				model.name
			)
			if (!retried.ok) {
				failed.push(model.name)
				progress(
					'Installing ELLA',
					'running',
					`${model.name} — FAILED: ${retried.error}`
				)
			} else {
				installed.push(model.name)
				progress(
					'Installing ELLA',
					'running',
					`${model.name} — done`
				)
			}
		}

		// Download T5 encoder
		const t5Path = 'models/t5_model/flan-t5-xl'
		const t5Exists = await fileExistsInWorkspace(
			workspace,
			`${t5Path}/config.json`
		)
		if (t5Exists) {
			skipped.push('T5 encoder')
			progress(
				'Installing ELLA',
				'running',
				'T5 encoder — already exists'
			)
		} else {
			progress(
				'Installing ELLA',
				'running',
				'Downloading T5 text encoder...'
			)
			const hasHfCli = await commandExists(
				'huggingface-cli'
			)
			let t5ok = false
			if (hasHfCli) {
				t5ok = (
					await run([
						'huggingface-cli',
						'download',
						'google/flan-t5-xl',
						'--local-dir',
						`${workspace}/${t5Path}`
					])
				).ok
			} else {
				const hasGit = await commandExists('git')
				if (hasGit) {
					t5ok = (
						await run([
							'git',
							'clone',
							'--depth',
							'1',
							'https://huggingface.co/google/flan-t5-xl',
							`${workspace}/${t5Path}`
						])
					).ok
				}
			}
			if (t5ok) {
				installed.push('T5 encoder (flan-t5-xl)')
				progress(
					'Installing ELLA',
					'running',
					'T5 encoder — done'
				)
			} else {
				failed.push('T5 encoder (flan-t5-xl)')
				progress(
					'Installing ELLA',
					'running',
					'T5 encoder — FAILED'
				)
			}
		}
	}

	return true
}

// ── Background download of remaining models ─────────────────────────────────

export function downloadRemainingModelsInBackground(opts: {
	civitaiToken?: string
	onProgress?: ProgressFn
}): void {
	void _downloadRemainingModels(opts).catch(err => {
		console.error(
			'[auto-setup] Background model download failed:',
			err
		)
	})
}

async function _downloadRemainingModels(opts: {
	civitaiToken?: string
	onProgress?: ProgressFn
}): Promise<void> {
	const { civitaiToken, onProgress } = opts
	const progress = onProgress ?? noop

	const release = await acquireLock()
	try {
		const workspace = await getComfyWorkspace()
		if (!workspace) return

		const missing: Array<{
			name: string
			filename: string
			url: string
			dest: string
			category: string
		}> = []

		for (const ckpt of CHECKPOINTS) {
			if (
				!(await fileExistsInWorkspace(
					workspace,
					`${ckpt.dest}/${ckpt.filename}`
				))
			) {
				missing.push({ ...ckpt, category: 'checkpoint' })
			}
		}
		for (const lora of LORAS) {
			if (
				!(await fileExistsInWorkspace(
					workspace,
					`${lora.dest}/${lora.filename}`
				))
			) {
				missing.push({ ...lora, category: 'lora' })
			}
		}
		for (const ella of ELLA_MODELS) {
			if (
				!(await fileExistsInWorkspace(
					workspace,
					`${ella.dest}/${ella.filename}`
				))
			) {
				missing.push({ ...ella, category: 'ella' })
			}
		}

		const t5Path = 'models/t5_model/flan-t5-xl'
		const t5Missing = !(await fileExistsInWorkspace(
			workspace,
			`${t5Path}/config.json`
		))

		const needsEllaNode =
			missing.some(m => m.category === 'ella') || t5Missing

		const totalRemaining =
			missing.length +
			(t5Missing ? 1 : 0) +
			(needsEllaNode ? 1 : 0)
		if (totalRemaining === 0) return

		progress(
			'Downloading remaining models',
			'started',
			`${totalRemaining} item(s) to download`,
			0,
			totalRemaining
		)

		let step = 0

		if (needsEllaNode) {
			step++
			progress(
				'Downloading remaining models',
				'running',
				'Installing ComfyUI-ELLA node...',
				step,
				totalRemaining
			)
			const nodeResult = await run([
				'comfy',
				'node',
				'install',
				'ComfyUI-ELLA'
			])
			if (!nodeResult.ok) {
				const errDetail = (
					nodeResult.stderr || nodeResult.stdout
				)
					.slice(-200)
					.trim()
				progress(
					'Downloading remaining models',
					'running',
					`ComfyUI-ELLA node — failed: ${errDetail}`,
					step,
					totalRemaining
				)
			} else {
				progress(
					'Downloading remaining models',
					'running',
					'ComfyUI-ELLA node — done',
					step,
					totalRemaining
				)
			}
		}

		for (const model of missing) {
			step++
			progress(
				'Downloading remaining models',
				'running',
				`Downloading ${model.name}...`,
				step,
				totalRemaining
			)

			const args = [
				'comfy',
				'model',
				'download',
				'--url',
				model.url,
				'--relative-path',
				model.dest
			]
			if (
				civitaiToken &&
				model.url.includes('civitai.com')
			) {
				args.push('--set-civitai-api-token', civitaiToken)
			}
			const result = await run(args, { stdin: '\n' })
			if (result.ok) {
				progress(
					'Downloading remaining models',
					'running',
					`${model.name} — done`,
					step,
					totalRemaining
				)
			} else {
				const errDetail = (result.stderr || result.stdout)
					.slice(-200)
					.trim()
				progress(
					'Downloading remaining models',
					'running',
					`${model.name} — failed: ${errDetail}`,
					step,
					totalRemaining
				)
			}
		}

		if (t5Missing) {
			step++
			progress(
				'Downloading remaining models',
				'running',
				'Downloading T5 text encoder...',
				step,
				totalRemaining
			)
			const hasHfCli = await commandExists(
				'huggingface-cli'
			)
			let t5ok = false
			if (hasHfCli) {
				t5ok = (
					await run([
						'huggingface-cli',
						'download',
						'google/flan-t5-xl',
						'--local-dir',
						`${workspace}/${t5Path}`
					])
				).ok
			} else {
				const hasGit = await commandExists('git')
				if (hasGit) {
					t5ok = (
						await run([
							'git',
							'clone',
							'--depth',
							'1',
							'https://huggingface.co/google/flan-t5-xl',
							`${workspace}/${t5Path}`
						])
					).ok
				}
			}
			if (t5ok) {
				progress(
					'Downloading remaining models',
					'running',
					'T5 encoder — done',
					step,
					totalRemaining
				)
			} else {
				progress(
					'Downloading remaining models',
					'running',
					'T5 encoder — failed',
					step,
					totalRemaining
				)
			}
		}

		progress(
			'Downloading remaining models',
			'completed',
			'All models ready'
		)
	} finally {
		release()
	}
}
