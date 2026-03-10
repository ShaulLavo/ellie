/**
 * ComfyUI REST + WebSocket client.
 * Talks to a running ComfyUI server to queue prompts, stream progress, and retrieve output images.
 */

export interface ComfyUIClientConfig {
	baseUrl: string
	timeout: number // ms
}

export interface ProgressCallback {
	(info: {
		step: number
		totalSteps: number
		node?: string
	}): void
}

interface QueuePromptResponse {
	prompt_id: string
	number: number
	node_errors: Record<string, unknown>
}

interface HistoryImageOutput {
	filename: string
	subfolder: string
	type: string
}

interface HistoryOutput {
	images?: HistoryImageOutput[]
}

interface HistoryEntry {
	outputs: Record<string, HistoryOutput>
	status: { status_str: string; completed: boolean }
}

export class ComfyUIClient {
	private baseUrl: string
	private timeout: number

	constructor(config: ComfyUIClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, '')
		this.timeout = config.timeout
	}

	/** Check if ComfyUI is reachable. */
	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(
				`${this.baseUrl}/system_stats`,
				{ signal: AbortSignal.timeout(5000) }
			)
			return res.ok
		} catch {
			return false
		}
	}

	/** Queue a workflow for execution. Returns prompt_id and the client_id used. */
	async queuePrompt(
		workflow: Record<string, unknown>
	): Promise<QueuePromptResponse & { client_id: string }> {
		const clientId = crypto.randomUUID()
		const res = await fetch(`${this.baseUrl}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				prompt: workflow,
				client_id: clientId
			})
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(
				`ComfyUI /prompt failed (${res.status}): ${text}`
			)
		}

		const data = (await res.json()) as QueuePromptResponse

		if (
			data.node_errors &&
			Object.keys(data.node_errors).length > 0
		) {
			throw new Error(
				`ComfyUI node errors: ${JSON.stringify(data.node_errors)}`
			)
		}

		return { ...data, client_id: clientId }
	}

	/**
	 * Wait for completion via ComfyUI's WebSocket for real-time progress.
	 * Falls back to HTTP polling if WebSocket fails to connect.
	 */
	async waitForCompletion(
		promptId: string,
		clientId: string,
		onProgress?: ProgressCallback
	): Promise<HistoryEntry> {
		try {
			return await this.waitViaWebSocket(
				promptId,
				clientId,
				onProgress
			)
		} catch (wsErr) {
			console.warn(
				'[comfyui] WebSocket failed, falling back to polling:',
				wsErr
			)
			return await this.waitViaPolling(promptId)
		}
	}

	/** Fetch a generated image from ComfyUI's /view endpoint. */
	async getOutputImage(
		filename: string,
		subfolder: string,
		type: string
	): Promise<{ data: ArrayBuffer; mime: string }> {
		const params = new URLSearchParams({
			filename,
			subfolder,
			type
		})
		const res = await fetch(
			`${this.baseUrl}/view?${params}`
		)

		if (!res.ok) {
			throw new Error(
				`ComfyUI /view failed (${res.status}): ${filename}`
			)
		}

		const data = await res.arrayBuffer()
		const mime =
			res.headers.get('content-type') ?? 'image/png'
		return { data, mime }
	}

	// ── WebSocket-based completion ──────────────────────────────────────────

	private waitViaWebSocket(
		promptId: string,
		clientId: string,
		onProgress?: ProgressCallback
	): Promise<HistoryEntry> {
		return new Promise((resolve, reject) => {
			const wsUrl =
				this.baseUrl.replace(/^http/, 'ws') +
				`/ws?clientId=${clientId}`
			const ws = new WebSocket(wsUrl)
			let settled = false
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true
					ws.close()
					reject(
						new Error(
							`ComfyUI generation timed out after ${this.timeout}ms`
						)
					)
				}
			}, this.timeout)

			ws.addEventListener('message', async event => {
				if (settled) return
				try {
					const raw =
						typeof event.data === 'string'
							? event.data
							: await new Response(event.data).text()
					const msg = JSON.parse(raw)

					if (
						msg.type === 'progress' &&
						msg.data?.prompt_id === promptId
					) {
						onProgress?.({
							step: msg.data.value,
							totalSteps: msg.data.max,
							node: msg.data.node ?? undefined
						})
					}

					if (
						msg.type === 'executing' &&
						msg.data?.prompt_id === promptId
					) {
						// node === null means execution finished
						if (msg.data.node === null) {
							settled = true
							clearTimeout(timer)
							ws.close()
							const entry =
								await this.fetchHistory(promptId)
							resolve(entry)
						}
					}
				} catch {
					// Ignore parse errors on individual messages
				}
			})

			ws.addEventListener('error', () => {
				if (!settled) {
					settled = true
					clearTimeout(timer)
					ws.close()
					reject(
						new Error('ComfyUI WebSocket connection error')
					)
				}
			})

			ws.addEventListener('close', event => {
				if (!settled && !event.wasClean) {
					settled = true
					clearTimeout(timer)
					reject(
						new Error(
							'ComfyUI WebSocket closed unexpectedly'
						)
					)
				}
			})
		})
	}

	// ── HTTP polling fallback ──────────────────────────────────────────────

	private async waitViaPolling(
		promptId: string
	): Promise<HistoryEntry> {
		const start = Date.now()
		const pollInterval = 2000

		while (Date.now() - start < this.timeout) {
			try {
				const entry = await this.fetchHistory(promptId)
				if (entry.status?.completed) return entry
			} catch {
				// Ignore fetch errors during polling
			}
			await new Promise(r => setTimeout(r, pollInterval))
		}

		throw new Error(
			`ComfyUI generation timed out after ${this.timeout}ms for prompt ${promptId}`
		)
	}

	private async fetchHistory(
		promptId: string
	): Promise<HistoryEntry> {
		const res = await fetch(
			`${this.baseUrl}/history/${promptId}`
		)
		if (!res.ok) {
			throw new Error(
				`ComfyUI /history failed (${res.status})`
			)
		}
		const data = (await res.json()) as Record<
			string,
			HistoryEntry
		>
		const entry = data[promptId]
		if (!entry) {
			throw new Error(
				`No history entry for prompt ${promptId}`
			)
		}
		return entry
	}
}
