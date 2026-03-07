/**
 * Speech routes — transcription proxy to the Rust STT service.
 *
 * POST /api/speech/transcriptions
 *   Accepts multipart audio, proxies to STT, stores draft artifact,
 *   returns transcript text + speechRef.
 *
 * Every transcription request is traced as a root `speech` trace with
 * child spans for STT proxy and artifact creation.
 */

import { Elysia } from 'elysia'
import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { ulid } from 'fast-ulid'
import type { EventStore } from '@ellie/db'
import {
	type TraceRecorder,
	createRootScope,
	createChildScope
} from '@ellie/trace'
import {
	BadRequestError,
	InternalServerError,
	ServiceUnavailableError
} from './http-errors'

const SPEECH_DRAFT_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function createSpeechRoutes(
	eventStore: EventStore,
	dataDir: string,
	sttBaseUrl: string,
	traceRecorder?: TraceRecorder
) {
	const speechAudioDir = join(dataDir, 'speech-audio')
	if (!existsSync(speechAudioDir)) {
		mkdirSync(speechAudioDir, { recursive: true })
	}

	return new Elysia({
		prefix: '/api/speech',
		tags: ['Speech']
	}).post(
		'/transcriptions',
		async ({ request }) => {
			// ── Root trace scope ────────────────────────────────
			const scope = traceRecorder
				? createRootScope({ traceKind: 'speech' })
				: undefined

			// Parse multipart form data
			let formData: FormData
			try {
				formData = await request.formData()
			} catch {
				throw new BadRequestError(
					'Invalid multipart form data'
				)
			}

			const audioField = formData.get('audio')
			if (!audioField || !(audioField instanceof Blob)) {
				throw new BadRequestError(
					"Missing 'audio' field in multipart body"
				)
			}

			const source =
				(formData.get('source') as string) ?? 'microphone'
			const normalizedBy =
				(formData.get('normalizedBy') as string) ?? 'none'

			// Read audio bytes once — avoids double-consumption of the blob
			const audioBytes = await audioField.arrayBuffer()
			const audioBlob = new Blob([audioBytes], {
				type: audioField.type || 'audio/wav'
			})

			if (traceRecorder && scope) {
				traceRecorder.record(
					scope,
					'speech.start',
					'speech',
					{
						source,
						normalizedBy,
						mime: audioField.type || 'audio/wav',
						audioSize: audioBytes.byteLength
					}
				)
			}

			// ── STT proxy span ─────────────────────────────────
			const sttScope =
				traceRecorder && scope
					? createChildScope(scope)
					: undefined

			const sttForm = new FormData()
			sttForm.append('audio', audioBlob, 'recording.wav')

			// Forward optional params field if present
			const params = formData.get('params')
			if (params) {
				sttForm.append(
					'params',
					typeof params === 'string'
						? params
						: await (params as Blob).text()
				)
			}

			if (traceRecorder && sttScope) {
				traceRecorder.record(
					sttScope,
					'stt.request',
					'speech',
					{
						url: `${sttBaseUrl}/transcribe`,
						audioSize: audioBytes.byteLength
					}
				)
			}

			let sttResponse: Response
			try {
				sttResponse = await fetch(
					`${sttBaseUrl}/transcribe`,
					{
						method: 'POST',
						body: sttForm
					}
				)
			} catch (err) {
				if (traceRecorder && sttScope) {
					traceRecorder.record(
						sttScope,
						'stt.error',
						'speech',
						{
							error: 'STT service unreachable',
							detail:
								err instanceof Error
									? err.message
									: String(err)
						}
					)
				}
				throw new ServiceUnavailableError(
					'STT service is not reachable'
				)
			}

			if (!sttResponse.ok) {
				const errBody = await sttResponse
					.json()
					.catch(() => ({
						error: sttResponse.statusText
					}))
				const errMsg =
					(errBody as { error?: string }).error ??
					`STT returned ${sttResponse.status}`

				if (traceRecorder && sttScope) {
					traceRecorder.record(
						sttScope,
						'stt.error',
						'speech',
						{
							status: sttResponse.status,
							error: errMsg
						}
					)
				}

				// Map upstream 5xx → InternalServerError, 4xx → BadRequest
				if (sttResponse.status >= 500) {
					throw new InternalServerError(
						`STT service error: ${errMsg}`
					)
				}
				throw new BadRequestError(errMsg)
			}

			const sttResult = (await sttResponse.json()) as {
				text: string
				duration_ms: number
				speech_detected: boolean
			}

			if (traceRecorder && sttScope) {
				traceRecorder.record(
					sttScope,
					'stt.response',
					'speech',
					{
						status: sttResponse.status,
						speechDetected: sttResult.speech_detected,
						durationMs: sttResult.duration_ms,
						textLength: sttResult.text.length
					}
				)
			}

			// ── Artifact creation span ─────────────────────────
			const artifactScope =
				traceRecorder && scope
					? createChildScope(scope)
					: undefined

			// Store audio blob on disk (reuse the bytes we already read)
			const id = ulid()
			const blobPath = join(speechAudioDir, `${id}.wav`)
			await Bun.write(blobPath, audioBytes)

			// Create draft speech artifact
			const now = Date.now()
			eventStore.speechArtifacts.create({
				id,
				status: 'draft',
				blobPath,
				source,
				flow: 'transcript-first',
				mime: audioField.type || 'audio/wav',
				size: audioBytes.byteLength,
				normalizedBy,
				transcriptText: sttResult.text,
				durationMs: sttResult.duration_ms,
				speechDetected: sttResult.speech_detected,
				createdAt: now,
				expiresAt: now + SPEECH_DRAFT_TTL_MS
			})

			if (traceRecorder && artifactScope) {
				traceRecorder.record(
					artifactScope,
					'speech.artifact-created',
					'speech',
					{
						artifactId: id,
						blobPath,
						status: 'draft',
						expiresAt: now + SPEECH_DRAFT_TTL_MS
					}
				)
			}

			// ── End root trace ──────────────────────────────────
			if (traceRecorder && scope) {
				traceRecorder.record(scope, 'speech.end', 'speech', {
					speechRef: id,
					speechDetected: sttResult.speech_detected,
					durationMs: sttResult.duration_ms
				})
			}

			return {
				text: sttResult.text,
				speechRef: id,
				speechDetected: sttResult.speech_detected,
				durationMs: sttResult.duration_ms
			}
		}
	)
}
