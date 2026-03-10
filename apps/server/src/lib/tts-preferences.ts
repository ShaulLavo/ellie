/**
 * TTS preferences — persistent user voice settings.
 *
 * Stored at DATA_DIR/tts/preferences.json.
 * The agent can change defaults via the `set_default_voice` tool.
 * The post-processor reads these on each synthesis call.
 */

import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ElevenLabsVoiceSettings } from './tts'

export interface TtsPreferences {
	voiceId?: string
	modelId?: string
	voiceSettings?: Partial<ElevenLabsVoiceSettings>
}

function prefsPath(dataDir: string): string {
	return resolve(dataDir, 'tts', 'preferences.json')
}

export async function loadTtsPreferences(
	dataDir: string
): Promise<TtsPreferences> {
	try {
		const file = Bun.file(prefsPath(dataDir))
		if (!(await file.exists())) return {}
		return (await file.json()) as TtsPreferences
	} catch {
		return {}
	}
}

export async function saveTtsPreferences(
	dataDir: string,
	prefs: TtsPreferences
): Promise<void> {
	const dir = resolve(dataDir, 'tts')
	await mkdir(dir, { recursive: true })
	await Bun.write(
		prefsPath(dataDir),
		JSON.stringify(prefs, null, 2) + '\n'
	)
}
