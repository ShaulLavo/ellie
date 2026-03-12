/**
 * HTTP client for the Python image-gen service.
 * Sends generation requests and parses NDJSON progress streams.
 */

import { readJsonLines } from './jsonl-reader'
import type { ProgressFn } from './auto-setup'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServiceGenerateImage {
	imagePath: string
	width: number
	height: number
}

export interface ServiceGenerateResult {
	imagePath: string
	width: number
	height: number
	seed: number
	images: ServiceGenerateImage[]
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Send a generate request to the service and stream progress events.
 * Returns the final result when the generation completes.
 */
export async function serviceGenerate(
	baseUrl: string,
	config: Record<string, unknown>,
	onProgress?: ProgressFn
): Promise<ServiceGenerateResult> {
	const resp = await fetch(`${baseUrl}/generate/stream`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(config)
	})

	if (resp.status === 409) {
		const body = (await resp.json()) as {
			error: { message: string }
		}
		throw new Error(`Service busy: ${body.error.message}`)
	}

	if (resp.status === 422) {
		const body = (await resp.json()) as {
			error: { message: string }
		}
		throw new Error(
			`Validation error: ${body.error.message}`
		)
	}

	if (!resp.ok) {
		const text = await resp.text()
		throw new Error(
			`Service error (${resp.status}): ${text.slice(0, 500)}`
		)
	}

	if (!resp.body) {
		throw new Error('No response body from service')
	}

	// Parse NDJSON stream
	for await (const event of readJsonLines(resp.body)) {
		const eventType = event.event as string

		if (eventType === 'progress') {
			const phase = event.phase as string
			const message = event.message as string | undefined
			const step = event.step as number | undefined
			const totalSteps = event.totalSteps as
				| number
				| undefined

			switch (phase) {
				case 'download':
					onProgress?.('download', 'running', message)
					break
				case 'load':
					onProgress?.(
						'load',
						'running',
						message,
						step,
						totalSteps
					)
					break
				case 'lora':
					onProgress?.('lora', 'running', message)
					break
				case 'ella':
					onProgress?.('ella', 'running', message)
					break
				case 'denoise':
					onProgress?.(
						'denoising',
						'running',
						message,
						step,
						totalSteps
					)
					break
				case 'save':
					onProgress?.('save', 'running', message)
					break
			}
		} else if (eventType === 'result') {
			const images = (event.images as
				| ServiceGenerateImage[]
				| undefined) ?? [
				{
					imagePath: event.imagePath as string,
					width: event.width as number,
					height: event.height as number
				}
			]
			return {
				imagePath: event.imagePath as string,
				width: event.width as number,
				height: event.height as number,
				seed: event.seed as number,
				images
			}
		} else if (eventType === 'error') {
			const code = event.code as string | undefined
			const message = event.message as string
			throw new Error(
				code ? `[${code}] ${message}` : message
			)
		}
	}

	throw new Error('Service stream ended without result')
}
