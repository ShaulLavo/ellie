/**
 * set_default_voice — persist the default TTS voice.
 *
 * Updates DATA_DIR/tts/preferences.json with a new default voiceId
 * and optional voice settings. Takes effect on the next TTS synthesis.
 */

import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import {
	isValidVoiceId,
	loadTtsPreferences,
	saveTtsPreferences
} from '../../lib/tts-preferences'
import * as v from 'valibot'

const setDefaultVoiceParams = v.object({
	voiceId: v.pipe(
		v.string(),
		v.description(
			'ElevenLabs voice ID to set as the new default'
		)
	),
	voiceName: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Human-readable voice name (for confirmation message)'
			)
		)
	),
	stability: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description(
				'Default voice stability (0-1). Lower = more expressive, higher = more consistent.'
			)
		)
	),
	similarityBoost: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description(
				'Default similarity boost (0-1). Higher = closer to original voice.'
			)
		)
	),
	speed: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0.5),
			v.maxValue(2),
			v.description(
				'Default speech speed (0.5-2). 1.0 = normal.'
			)
		)
	)
})

type SetDefaultVoiceParams = v.InferOutput<
	typeof setDefaultVoiceParams
>

export function createSetDefaultVoiceTool(
	dataDir: string
): AgentTool {
	return {
		name: 'set_default_voice',
		description:
			'Change the default TTS voice for all future [[tts]] replies. ' +
			'Use browse_voice_catalog first to find available voice IDs. ' +
			'Optionally set default stability, similarityBoost, and speed.',
		label: 'Setting default voice',
		parameters: setDefaultVoiceParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as SetDefaultVoiceParams

			if (!isValidVoiceId(params.voiceId)) {
				return {
					content: [
						{
							type: 'text',
							text: `Invalid voice ID format: "${params.voiceId}". Must be 10-40 alphanumeric characters.`
						}
					],
					details: { success: false }
				}
			}

			try {
				const current = await loadTtsPreferences(dataDir)
				const previousVoiceId =
					current.voiceId ?? '(system default)'

				// Update preferences
				current.voiceId = params.voiceId
				if (
					params.stability !== undefined ||
					params.similarityBoost !== undefined ||
					params.speed !== undefined
				) {
					current.voiceSettings = {
						...current.voiceSettings,
						...(params.stability !== undefined && {
							stability: params.stability
						}),
						...(params.similarityBoost !== undefined && {
							similarityBoost: params.similarityBoost
						}),
						...(params.speed !== undefined && {
							speed: params.speed
						})
					}
				}

				await saveTtsPreferences(dataDir, current)

				const name = params.voiceName
					? ` (${params.voiceName})`
					: ''
				const settings: string[] = []
				if (params.stability !== undefined)
					settings.push(`stability: ${params.stability}`)
				if (params.similarityBoost !== undefined)
					settings.push(
						`similarityBoost: ${params.similarityBoost}`
					)
				if (params.speed !== undefined)
					settings.push(`speed: ${params.speed}`)

				const settingsStr = settings.length
					? `\nVoice settings: ${settings.join(', ')}`
					: ''

				return {
					content: [
						{
							type: 'text',
							text:
								`Default voice updated.\n` +
								`Previous: ${previousVoiceId}\n` +
								`New: ${params.voiceId}${name}${settingsStr}`
						}
					],
					details: {
						success: true,
						previousVoiceId,
						newVoiceId: params.voiceId
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: 'text',
							text: `Failed to save voice preferences: ${msg}`
						}
					],
					details: { success: false, error: msg }
				}
			}
		}
	}
}
