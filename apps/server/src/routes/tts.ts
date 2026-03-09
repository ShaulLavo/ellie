import * as v from 'valibot'
import { Elysia } from 'elysia'
import type { BlobSink, TraceRecorder } from '@ellie/trace'
import { createRootScope } from '@ellie/trace'
import {
	BadRequestError,
	ServiceUnavailableError
} from './http-errors'
import {
	ELEVENLABS_MODELS,
	elevenLabsTTS,
	resolveElevenLabsApiKey,
	resolveElevenLabsTtsConfig
} from '../lib/tts'

const voiceSettingsSchema = v.object({
	stability: v.optional(v.number()),
	similarityBoost: v.optional(v.number()),
	style: v.optional(v.number()),
	useSpeakerBoost: v.optional(v.boolean()),
	speed: v.optional(v.number())
})

const ttsConvertBodySchema = v.object({
	text: v.pipe(
		v.string(),
		v.transform(input => input.trim()),
		v.nonEmpty()
	),
	voiceId: v.optional(v.string()),
	modelId: v.optional(v.string()),
	seed: v.optional(v.number()),
	applyTextNormalization: v.optional(
		v.picklist(['auto', 'on', 'off'])
	),
	languageCode: v.optional(v.string()),
	outputFormat: v.optional(v.string()),
	voiceSettings: v.optional(voiceSettingsSchema)
})

const ttsStatusSchema = v.object({
	provider: v.literal('elevenlabs'),
	configured: v.boolean(),
	voiceId: v.string(),
	modelId: v.string(),
	baseUrl: v.string(),
	maxTextLength: v.number(),
	timeoutMs: v.number()
})

const ttsProvidersSchema = v.object({
	providers: v.array(
		v.object({
			id: v.literal('elevenlabs'),
			name: v.literal('ElevenLabs'),
			configured: v.boolean(),
			models: v.array(v.string())
		})
	),
	active: v.nullable(v.literal('elevenlabs'))
})

const ttsConvertResponseSchema = v.object({
	uploadId: v.string(),
	provider: v.literal('elevenlabs'),
	outputFormat: v.string(),
	mime: v.string(),
	size: v.number(),
	voiceCompatible: v.boolean(),
	audio: v.object({
		type: v.literal('audio'),
		file: v.string(),
		mime: v.string(),
		size: v.number()
	})
})

export function createTtsRoutes(
	blobSink: BlobSink,
	traceRecorder?: TraceRecorder
) {
	return new Elysia({
		prefix: '/api/tts',
		tags: ['Speech']
	})
		.get(
			'/status',
			() => {
				const config = resolveElevenLabsTtsConfig()
				return {
					provider: 'elevenlabs' as const,
					configured: Boolean(resolveElevenLabsApiKey()),
					voiceId: config.voiceId,
					modelId: config.modelId,
					baseUrl: config.baseUrl,
					maxTextLength: config.maxTextLength,
					timeoutMs: config.timeoutMs
				}
			},
			{
				response: ttsStatusSchema
			}
		)
		.get(
			'/providers',
			() => {
				const configured = Boolean(
					resolveElevenLabsApiKey()
				)
				return {
					providers: [
						{
							id: 'elevenlabs' as const,
							name: 'ElevenLabs' as const,
							configured,
							models: [...ELEVENLABS_MODELS]
						}
					],
					active: configured
						? ('elevenlabs' as const)
						: null
				}
			},
			{
				response: ttsProvidersSchema
			}
		)
		.post(
			'/convert',
			async ({ body }) => {
				const config = resolveElevenLabsTtsConfig()
				if (!config.apiKey) {
					throw new ServiceUnavailableError(
						'ElevenLabs is not configured'
					)
				}

				const scope = createRootScope({
					traceKind: 'speech'
				})
				traceRecorder?.record(scope, 'tts.start', 'tts', {
					textLength: body.text.length,
					voiceId: body.voiceId,
					modelId: body.modelId,
					outputFormat: body.outputFormat
				})

				try {
					const result = await elevenLabsTTS({
						text: body.text,
						config,
						overrides: {
							voiceId: body.voiceId,
							modelId: body.modelId,
							seed: body.seed,
							applyTextNormalization:
								body.applyTextNormalization,
							languageCode: body.languageCode,
							outputFormat: body.outputFormat,
							voiceSettings: body.voiceSettings
						}
					})

					const blobRef = await blobSink.write({
						traceId: scope?.traceId ?? 'tts',
						spanId: scope?.spanId ?? 'tts',
						role: 'tts_output',
						content: result.audio,
						mimeType: result.mime,
						ext: result.extension
					})

					traceRecorder?.record(scope, 'tts.end', 'tts', {
						uploadId: blobRef.uploadId,
						size: result.audio.length,
						mime: result.mime,
						outputFormat: result.outputFormat
					})

					return {
						uploadId: blobRef.uploadId,
						provider: result.provider,
						outputFormat: result.outputFormat,
						mime: result.mime,
						size: result.audio.length,
						voiceCompatible: result.voiceCompatible,
						audio: {
							type: 'audio' as const,
							file: blobRef.uploadId,
							mime: result.mime,
							size: result.audio.length
						}
					}
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: String(error)
					traceRecorder?.record(scope, 'tts.error', 'tts', {
						message
					})
					throw new BadRequestError(message)
				}
			},
			{
				body: ttsConvertBodySchema,
				response: ttsConvertResponseSchema
			}
		)
}
