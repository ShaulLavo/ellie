import {
	useRef,
	useState,
	useCallback,
	useEffect,
	memo
} from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

const PAUSE_OTHERS = 'voice-message:pause-others'
let idCounter = 0

interface VoiceMessageProps {
	src: string
	duration?: number
	waveform?: string
	className?: string
}

const SVG_W = 220
const SVG_H = 32
const BAR_W = 2
const DEFAULT_COUNT = 44
const MAX_COUNT = 60

function getBarLayout(dur: number) {
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

function parseWaveform(raw?: string): number[] | null {
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

function resample(data: number[], count: number): number[] {
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

function generateWaveform(count: number): number[] {
	const bars: number[] = []
	let seed = 42
	for (let i = 0; i < count; i++) {
		seed = (seed * 16807 + 7) % 2147483647
		bars.push(0.15 + ((seed % 1000) / 1000) * 0.85)
	}
	return bars
}

function fmtTime(s: number): string {
	const m = Math.floor(s / 60)
	return `${m}:${Math.floor(s % 60)
		.toString()
		.padStart(2, '0')}`
}

function clampTime(time: number, duration: number): number {
	return Math.min(Math.max(time, 0), duration)
}

function getAudioDuration(
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

function getSeekRatio(
	clientX: number,
	rect: DOMRect
): number {
	if (rect.width <= 0) return 0
	return Math.max(
		0,
		Math.min(1, (clientX - rect.left) / rect.width)
	)
}

function releasePointerCapture(
	target: SVGSVGElement,
	pointerId: number
) {
	if (!target.hasPointerCapture(pointerId)) return
	target.releasePointerCapture(pointerId)
}

export const VoiceMessage = memo(
	({
		src,
		duration: initialDuration,
		waveform: waveformData,
		className
	}: VoiceMessageProps) => {
		const audioRef = useRef<HTMLAudioElement>(null)
		const svgRef = useRef<SVGSVGElement>(null)
		const idRef = useRef(++idCounter)
		const draggingRef = useRef(false)
		const pendingSeekTimeRef = useRef<number | null>(null)
		const [playing, setPlaying] = useState(false)
		const [dragging, setDragging] = useState(false)
		const [progress, setProgress] = useState(0)
		const [currentTime, setCurrentTime] = useState(0)
		const [duration, setDuration] = useState(
			initialDuration ?? 0
		)
		const durationRef = useRef(initialDuration ?? 0)

		const { count: barCount, gap: barGap } =
			getBarLayout(duration)

		const bars = resample(
			parseWaveform(waveformData) ??
				generateWaveform(barCount),
			barCount
		)

		useEffect(() => {
			if (!initialDuration || initialDuration <= 0) return
			setDuration(initialDuration)
		}, [initialDuration])

		useEffect(() => {
			durationRef.current = duration
		}, [duration])

		useEffect(() => {
			const handler = (e: Event) => {
				if (
					(e as CustomEvent<number>).detail !==
					idRef.current
				)
					audioRef.current?.pause()
			}
			window.addEventListener(PAUSE_OTHERS, handler)
			return () =>
				window.removeEventListener(PAUSE_OTHERS, handler)
		}, [])

		const toggle = useCallback(() => {
			const el = audioRef.current
			if (!el) return
			if (el.paused) {
				window.dispatchEvent(
					new CustomEvent(PAUSE_OTHERS, {
						detail: idRef.current
					})
				)
				el.play()
			} else {
				el.pause()
			}
		}, [])

		const resolveDuration = useCallback(
			(audio: HTMLAudioElement | null) =>
				getAudioDuration(audio, durationRef.current),
			[]
		)

		const syncPosition = useCallback(
			(nextTime: number, nextDuration: number) => {
				if (nextDuration <= 0) {
					setCurrentTime(Math.max(nextTime, 0))
					setProgress(0)
					return
				}
				const safeTime = clampTime(nextTime, nextDuration)
				setCurrentTime(safeTime)
				setProgress(safeTime / nextDuration)
			},
			[]
		)

		const commitPendingSeek = useCallback(
			(el: HTMLAudioElement) => {
				const pendingSeekTime = pendingSeekTimeRef.current
				if (pendingSeekTime === null) return
				if (
					!Number.isFinite(el.duration) ||
					el.duration <= 0
				) {
					return
				}
				const nextTime = clampTime(
					pendingSeekTime,
					el.duration
				)
				pendingSeekTimeRef.current = null
				el.currentTime = nextTime
				syncPosition(nextTime, el.duration)
			},
			[syncPosition]
		)

		const seekToClientX = useCallback(
			(clientX: number) => {
				const el = audioRef.current
				const svg = svgRef.current
				if (!el || !svg) return
				const targetDuration = resolveDuration(el)
				if (targetDuration <= 0) return

				const ratio = getSeekRatio(
					clientX,
					svg.getBoundingClientRect()
				)
				const targetTime = clampTime(
					ratio * targetDuration,
					targetDuration
				)

				pendingSeekTimeRef.current = targetTime
				syncPosition(targetTime, targetDuration)

				if (
					!Number.isFinite(el.duration) ||
					el.duration <= 0
				) {
					return
				}

				pendingSeekTimeRef.current = null
				el.currentTime = clampTime(targetTime, el.duration)
				syncPosition(el.currentTime, el.duration)
			},
			[resolveDuration, syncPosition]
		)

		const stopDragging = useCallback(
			(target: SVGSVGElement, pointerId: number) => {
				draggingRef.current = false
				setDragging(false)
				releasePointerCapture(target, pointerId)
			},
			[]
		)

		const startDragging = useCallback(
			(e: React.PointerEvent<SVGSVGElement>) => {
				if (e.pointerType === 'mouse' && e.button !== 0)
					return
				draggingRef.current = true
				setDragging(true)
				e.currentTarget.setPointerCapture(e.pointerId)
				seekToClientX(e.clientX)
			},
			[seekToClientX]
		)

		const dragSeek = useCallback(
			(e: React.PointerEvent<SVGSVGElement>) => {
				if (!draggingRef.current) return
				seekToClientX(e.clientX)
			},
			[seekToClientX]
		)

		const endDragging = useCallback(
			(e: React.PointerEvent<SVGSVGElement>) => {
				if (!draggingRef.current) return
				seekToClientX(e.clientX)
				stopDragging(e.currentTarget, e.pointerId)
			},
			[seekToClientX, stopDragging]
		)

		const cancelDragging = useCallback(
			(e: React.PointerEvent<SVGSVGElement>) => {
				if (!draggingRef.current) return
				stopDragging(e.currentTarget, e.pointerId)
			},
			[stopDragging]
		)

		useEffect(() => {
			const el = audioRef.current
			if (!el) return
			let rafId = 0

			const syncFromMedia = () => {
				const nextDuration = resolveDuration(el)
				if (nextDuration <= 0) return
				syncPosition(el.currentTime, nextDuration)
			}

			const tick = () => {
				syncFromMedia()
				rafId = requestAnimationFrame(tick)
			}

			const onPlay = () => {
				setPlaying(true)
				cancelAnimationFrame(rafId)
				rafId = requestAnimationFrame(tick)
			}

			const onPause = () => {
				setPlaying(false)
				cancelAnimationFrame(rafId)
			}

			const onEnded = () => {
				pendingSeekTimeRef.current = null
				setPlaying(false)
				cancelAnimationFrame(rafId)
				syncPosition(0, resolveDuration(el))
			}

			const onMeta = () => {
				const nextDuration = resolveDuration(el)
				if (nextDuration <= 0) return
				setDuration(nextDuration)
				const hadPendingSeek =
					pendingSeekTimeRef.current !== null
				commitPendingSeek(el)
				if (hadPendingSeek) return
				syncPosition(el.currentTime, nextDuration)
			}

			el.addEventListener('play', onPlay)
			el.addEventListener('pause', onPause)
			el.addEventListener('ended', onEnded)
			el.addEventListener('seeked', syncFromMedia)
			el.addEventListener('timeupdate', syncFromMedia)
			el.addEventListener('loadedmetadata', onMeta)
			return () => {
				cancelAnimationFrame(rafId)
				el.removeEventListener('play', onPlay)
				el.removeEventListener('pause', onPause)
				el.removeEventListener('ended', onEnded)
				el.removeEventListener('seeked', syncFromMedia)
				el.removeEventListener('timeupdate', syncFromMedia)
				el.removeEventListener('loadedmetadata', onMeta)
			}
		}, [commitPendingSeek, resolveDuration, syncPosition])

		const played = progress > 0 ? progress * barCount : -1
		return (
			<div
				className={cn(
					'inline-flex flex-col gap-1 select-none',
					className
				)}
			>
				<audio ref={audioRef} src={src} preload="auto" />

				{/* Button + waveform — perfectly vertically centered */}
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={toggle}
						className="shrink-0 text-primary hover:text-primary/80 focus-visible:outline-none"
						aria-label={playing ? 'Pause' : 'Play'}
					>
						<svg
							width="28"
							height="28"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							{playing ? (
								<>
									<rect
										x="5"
										y="3"
										width="5"
										height="18"
										rx="1"
									/>
									<rect
										x="14"
										y="3"
										width="5"
										height="18"
										rx="1"
									/>
								</>
							) : (
								<path d="M6 3L20 12L6 21Z" />
							)}
						</svg>
					</button>

					<svg
						ref={svgRef}
						width={SVG_W}
						height={SVG_H}
						viewBox={`0 0 ${SVG_W} ${SVG_H}`}
						onPointerDown={startDragging}
						onPointerMove={dragSeek}
						onPointerUp={endDragging}
						onPointerCancel={cancelDragging}
						className={cn(
							'outline-none touch-none',
							dragging
								? 'cursor-grabbing'
								: 'cursor-pointer'
						)}
						role="slider"
						aria-label="Seek audio"
						aria-valuenow={Math.round(progress * 100)}
						aria-valuemin={0}
						aria-valuemax={100}
						tabIndex={0}
					>
						{bars.map((h, i) => {
							const barH = Math.max(
								3,
								Math.round(h * SVG_H)
							)
							const x = i * (BAR_W + barGap)
							const y = (SVG_H - barH) / 2
							// Per-bar fill: 0 = empty, 1 = full
							const fill = Math.max(
								0,
								Math.min(1, played - i)
							)
							const fillH = barH * fill
							const fillY = y + barH - fillH
							return (
								<g key={i}>
									<rect
										x={x}
										y={y}
										width={BAR_W}
										height={barH}
										rx={BAR_W / 2}
										fill="color-mix(in oklch, var(--color-muted-foreground) 50%, transparent)"
									/>
									{fill > 0 && (
										<motion.rect
											x={x}
											width={BAR_W}
											rx={BAR_W / 2}
											fill="var(--color-primary)"
											initial={false}
											animate={{
												y: fillY,
												height: fillH
											}}
											transition={{
												type: 'spring',
												stiffness: 400,
												damping: 25
											}}
										/>
									)}
								</g>
							)
						})}
					</svg>
				</div>

				{/* Time — below, indented past the button */}
				<div
					className="flex justify-between text-[10px] tabular-nums text-muted-foreground/50 leading-none"
					style={{ paddingLeft: 40 }}
				>
					<span>
						{playing || currentTime > 0
							? fmtTime(currentTime)
							: duration > 0
								? fmtTime(duration)
								: '--:--'}
					</span>
					{duration > 0 && (playing || currentTime > 0) && (
						<span>{fmtTime(duration)}</span>
					)}
				</div>
			</div>
		)
	}
)
