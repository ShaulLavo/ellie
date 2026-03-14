import {
	useRef,
	useState,
	useEffect,
	useEffectEvent
} from 'react'
import {
	clampTime,
	getAudioDuration,
	getSeekRatio,
	releasePointerCapture
} from '../utils/voice-message-utils'

const PAUSE_OTHERS = 'voice-message:pause-others'
let idCounter = 0
function nextId() {
	return ++idCounter
}

export function useAudioPlayer(initialDuration?: number) {
	const audioRef = useRef<HTMLAudioElement>(null)
	const svgRef = useRef<SVGSVGElement>(null)
	const idRef = useRef(nextId())
	const draggingRef = useRef(false)
	const pendingSeekTimeRef = useRef<number | null>(null)
	const [playing, setPlaying] = useState(false)
	const [dragging, setDragging] = useState(false)
	const [progress, setProgress] = useState(0)
	const [currentTime, setCurrentTime] = useState(0)
	const [duration, setDuration] = useState(
		initialDuration ?? 0
	)

	if (
		initialDuration &&
		initialDuration > 0 &&
		duration !== initialDuration
	) {
		setDuration(initialDuration)
	}

	// Pause other instances when this one plays
	useEffect(() => {
		const handler = (e: Event) => {
			if (
				(e as CustomEvent<number>).detail !== idRef.current
			)
				audioRef.current?.pause()
		}
		window.addEventListener(PAUSE_OTHERS, handler)
		return () =>
			window.removeEventListener(PAUSE_OTHERS, handler)
	}, [])

	const resolveDuration = (
		audio: HTMLAudioElement | null
	) => getAudioDuration(audio, duration)

	const syncPosition = (
		nextTime: number,
		nextDuration: number
	) => {
		if (nextDuration <= 0) {
			setCurrentTime(Math.max(nextTime, 0))
			setProgress(0)
			return
		}
		const safeTime = clampTime(nextTime, nextDuration)
		setCurrentTime(safeTime)
		setProgress(safeTime / nextDuration)
	}

	const commitPendingSeek = (el: HTMLAudioElement) => {
		const pendingSeekTime = pendingSeekTimeRef.current
		if (pendingSeekTime === null) return
		if (!Number.isFinite(el.duration) || el.duration <= 0) {
			return
		}
		const nextTime = clampTime(pendingSeekTime, el.duration)
		pendingSeekTimeRef.current = null
		el.currentTime = nextTime
		syncPosition(nextTime, el.duration)
	}

	const seekToClientX = (clientX: number) => {
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

		if (!Number.isFinite(el.duration) || el.duration <= 0) {
			return
		}

		pendingSeekTimeRef.current = null
		el.currentTime = clampTime(targetTime, el.duration)
		syncPosition(el.currentTime, el.duration)
	}

	const toggle = () => {
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
	}

	const stopDragging = (
		target: SVGSVGElement,
		pointerId: number
	) => {
		draggingRef.current = false
		setDragging(false)
		releasePointerCapture(target, pointerId)
	}

	const startDragging = (
		e: React.PointerEvent<SVGSVGElement>
	) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return
		draggingRef.current = true
		setDragging(true)
		e.currentTarget.setPointerCapture(e.pointerId)
		seekToClientX(e.clientX)
	}

	const dragSeek = (
		e: React.PointerEvent<SVGSVGElement>
	) => {
		if (!draggingRef.current) return
		seekToClientX(e.clientX)
	}

	const endDragging = (
		e: React.PointerEvent<SVGSVGElement>
	) => {
		if (!draggingRef.current) return
		seekToClientX(e.clientX)
		stopDragging(e.currentTarget, e.pointerId)
	}

	const cancelDragging = (
		e: React.PointerEvent<SVGSVGElement>
	) => {
		if (!draggingRef.current) return
		stopDragging(e.currentTarget, e.pointerId)
	}

	// Media event handler — called from the effect via useEffectEvent
	// so it always sees the latest closure values without re-subscribing.
	const onMediaEvent = useEffectEvent(
		(
			type:
				| 'play'
				| 'pause'
				| 'ended'
				| 'seeked'
				| 'timeupdate'
				| 'loadedmetadata',
			el: HTMLAudioElement
		) => {
			if (type === 'play' || type === 'pause') {
				setPlaying(type === 'play')
				return
			}
			if (type === 'ended') {
				pendingSeekTimeRef.current = null
				setPlaying(false)
				const d = resolveDuration(el)
				syncPosition(d, d)
				return
			}
			if (type === 'loadedmetadata') {
				const nextDuration = resolveDuration(el)
				if (nextDuration <= 0) return
				setDuration(nextDuration)
				const hadPendingSeek =
					pendingSeekTimeRef.current !== null
				commitPendingSeek(el)
				if (hadPendingSeek) return
				syncPosition(el.currentTime, nextDuration)
				return
			}
			// seeked | timeupdate
			const nextDuration = resolveDuration(el)
			if (nextDuration <= 0) return
			syncPosition(el.currentTime, nextDuration)
		}
	)

	// Subscribe to audio element events
	useEffect(() => {
		const el = audioRef.current
		if (!el) return
		let rafId = 0

		const syncFromMedia = () => {
			onMediaEvent('timeupdate', el)
		}

		const tick = () => {
			syncFromMedia()
			rafId = requestAnimationFrame(tick)
		}

		const onPlay = () => {
			onMediaEvent('play', el)
			cancelAnimationFrame(rafId)
			rafId = requestAnimationFrame(tick)
		}

		const onPause = () => {
			onMediaEvent('pause', el)
			cancelAnimationFrame(rafId)
		}

		const onEnded = () => {
			onMediaEvent('ended', el)
			cancelAnimationFrame(rafId)
		}

		const onSeeked = () => onMediaEvent('seeked', el)
		const onMeta = () => onMediaEvent('loadedmetadata', el)

		el.addEventListener('play', onPlay)
		el.addEventListener('pause', onPause)
		el.addEventListener('ended', onEnded)
		el.addEventListener('seeked', onSeeked)
		el.addEventListener('timeupdate', syncFromMedia)
		el.addEventListener('loadedmetadata', onMeta)
		return () => {
			cancelAnimationFrame(rafId)
			el.removeEventListener('play', onPlay)
			el.removeEventListener('pause', onPause)
			el.removeEventListener('ended', onEnded)
			el.removeEventListener('seeked', onSeeked)
			el.removeEventListener('timeupdate', syncFromMedia)
			el.removeEventListener('loadedmetadata', onMeta)
		}
	}, [])

	return {
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
	}
}
