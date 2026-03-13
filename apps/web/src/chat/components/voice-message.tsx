import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useAudioPlayer } from '../hooks/use-audio-player'
import {
	SVG_W,
	SVG_H,
	BAR_W,
	getBarLayout,
	parseWaveform,
	resample,
	generateWaveform,
	fmtTime
} from '../utils/voice-message-utils'

interface VoiceMessageProps {
	src: string
	duration?: number
	waveform?: string
	className?: string
}

export function VoiceMessage({
	src,
	duration: initialDuration,
	waveform: waveformData,
	className
}: VoiceMessageProps) {
	const {
		playing,
		dragging,
		progress,
		currentTime,
		duration,
		toggle,
		startDragging,
		dragSeek,
		endDragging,
		cancelDragging,
		audioRef,
		svgRef
	} = useAudioPlayer(initialDuration)

	const { count: barCount, gap: barGap } =
		getBarLayout(duration)

	const bars = resample(
		parseWaveform(waveformData) ??
			generateWaveform(barCount),
		barCount
	)

	const played = progress > 0 ? progress * barCount : -1

	return (
		<div
			className={cn(
				'inline-flex flex-col gap-1 select-none',
				className
			)}
		>
			<audio ref={audioRef} src={src} preload="auto" />

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
						dragging ? 'cursor-grabbing' : 'cursor-pointer'
					)}
					role="slider"
					aria-label="Seek audio"
					aria-valuenow={Math.round(progress * 100)}
					aria-valuemin={0}
					aria-valuemax={100}
					tabIndex={0}
				>
					{bars.map((h, i) => {
						const barH = Math.max(3, Math.round(h * SVG_H))
						const x = i * (BAR_W + barGap)
						const y = (SVG_H - barH) / 2
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
