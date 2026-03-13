export const SVG_W = 220
export const SVG_H = 32
export const BAR_W = 2

const DEFAULT_COUNT = 44
const MAX_COUNT = 60

export function getBarLayout(dur: number) {
	const count =
		dur > 0
			? Math.min(
					MAX_COUNT,
					Math.max(
						DEFAULT_COUNT,
						Math.round(DEFAULT_COUNT * Math.sqrt(dur / 6))
					)
				)
			: DEFAULT_COUNT
	const gap = (SVG_W - count * BAR_W) / (count - 1)
	return { count, gap }
}

export function parseWaveform(
	raw?: string
): number[] | null {
	if (!raw) return null
	try {
		const arr: number[] = JSON.parse(raw)
		if (!Array.isArray(arr) || arr.length === 0) return null
		const max = Math.max(...arr, 1)
		return arr.map(v => Math.max(0.08, v / max))
	} catch {
		const parts = raw
			.split(',')
			.map(Number)
			.filter(n => !Number.isNaN(n))
		if (parts.length === 0) return null
		const max = Math.max(...parts, 1)
		return parts.map(v => Math.max(0.08, v / max))
	}
}

export function resample(
	data: number[],
	count: number
): number[] {
	if (data.length === count) return data
	const out: number[] = []
	for (let i = 0; i < count; i++) {
		const pos = (i / (count - 1)) * (data.length - 1)
		const lo = Math.floor(pos)
		const hi = Math.min(lo + 1, data.length - 1)
		const t = pos - lo
		out.push(data[lo]! * (1 - t) + data[hi]! * t)
	}
	return out
}

export function generateWaveform(count: number): number[] {
	const bars: number[] = []
	let seed = 42
	for (let i = 0; i < count; i++) {
		seed = (seed * 16807 + 7) % 2147483647
		bars.push(0.15 + ((seed % 1000) / 1000) * 0.85)
	}
	return bars
}

export function fmtTime(s: number): string {
	const m = Math.floor(s / 60)
	return `${m}:${Math.floor(s % 60)
		.toString()
		.padStart(2, '0')}`
}

export function clampTime(
	time: number,
	duration: number
): number {
	return Math.min(Math.max(time, 0), duration)
}

export function getAudioDuration(
	audio: HTMLAudioElement | null,
	fallbackDuration: number
): number {
	if (
		audio &&
		Number.isFinite(audio.duration) &&
		audio.duration > 0
	) {
		return audio.duration
	}
	return fallbackDuration > 0 ? fallbackDuration : 0
}

export function getSeekRatio(
	clientX: number,
	rect: DOMRect
): number {
	if (rect.width <= 0) return 0
	return Math.max(
		0,
		Math.min(1, (clientX - rect.left) / rect.width)
	)
}

export function releasePointerCapture(
	target: SVGSVGElement,
	pointerId: number
) {
	if (!target.hasPointerCapture(pointerId)) return
	target.releasePointerCapture(pointerId)
}
