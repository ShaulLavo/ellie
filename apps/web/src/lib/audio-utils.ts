/**
 * Client-side audio normalization using Mediabunny.
 *
 * Resamples browser-recorded audio (typically webm/opus) to
 * 16 kHz mono PCM16 WAV — the format expected by the STT service.
 */

import {
	Input,
	Output,
	Conversion,
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	WavOutputFormat
} from 'mediabunny'

/**
 * Normalize an audio blob to 16 kHz mono WAV.
 * @throws {Error} If normalization fails (caller should fall back to raw blob).
 */
export async function normalizeToWav16kMono(
	blob: Blob
): Promise<Blob> {
	const input = new Input({
		source: new BlobSource(blob),
		formats: ALL_FORMATS
	})

	const target = new BufferTarget()
	const output = new Output({
		format: new WavOutputFormat(),
		target
	})

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			sampleRate: 16000,
			numberOfChannels: 1
		}
	})

	await conversion.execute()

	if (!target.buffer) {
		throw new Error(
			'Audio normalization produced no output'
		)
	}
	return new Blob([target.buffer], { type: 'audio/wav' })
}
