'use client'

import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
	Microphone as MicIcon,
	Stop as StopIcon
} from '@phosphor-icons/react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface SpeechRecognition extends EventTarget {
	continuous: boolean
	interimResults: boolean
	lang: string
	start(): void
	stop(): void
	onstart:
		| ((this: SpeechRecognition, ev: Event) => void)
		| null
	onend:
		| ((this: SpeechRecognition, ev: Event) => void)
		| null
	onresult:
		| ((
				this: SpeechRecognition,
				ev: SpeechRecognitionEvent
		  ) => void)
		| null
	onerror:
		| ((
				this: SpeechRecognition,
				ev: SpeechRecognitionErrorEvent
		  ) => void)
		| null
}

interface SpeechRecognitionEvent extends Event {
	results: SpeechRecognitionResultList
	resultIndex: number
}

interface SpeechRecognitionResultList {
	readonly length: number
	item(index: number): SpeechRecognitionResult
	[index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
	readonly length: number
	item(index: number): SpeechRecognitionAlternative
	[index: number]: SpeechRecognitionAlternative
	isFinal: boolean
}

interface SpeechRecognitionAlternative {
	transcript: string
	confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
	error: string
}

declare global {
	interface Window {
		SpeechRecognition: new () => SpeechRecognition
		webkitSpeechRecognition: new () => SpeechRecognition
	}
}

type SpeechInputMode =
	| 'speech-recognition'
	| 'media-recorder'
	| 'none'

export type MicRecordButtonProps = {
	onTranscriptionChange?: (text: string) => void
	onAudioRecorded?: (audioBlob: Blob) => Promise<string>
	forceMediaRecorder?: boolean
	lang?: string
	className?: string
}

const detectSpeechInputMode = (): SpeechInputMode => {
	if (typeof window === 'undefined') return 'none'
	if (
		'SpeechRecognition' in window ||
		'webkitSpeechRecognition' in window
	)
		return 'speech-recognition'
	if (
		'MediaRecorder' in window &&
		'mediaDevices' in navigator
	)
		return 'media-recorder'
	return 'none'
}

export const MicRecordButton = ({
	className,
	onTranscriptionChange,
	onAudioRecorded,
	forceMediaRecorder,
	lang = 'en-US'
}: MicRecordButtonProps) => {
	const [isListening, setIsListening] = useState(false)
	const [isProcessing, setIsProcessing] = useState(false)
	const [mode] = useState<SpeechInputMode>(() => {
		if (forceMediaRecorder) {
			if (
				typeof window !== 'undefined' &&
				'MediaRecorder' in window &&
				'mediaDevices' in navigator
			)
				return 'media-recorder'
			return 'none'
		}
		return detectSpeechInputMode()
	})
	const [isRecognitionReady, setIsRecognitionReady] =
		useState(false)
	const recognitionRef = useRef<SpeechRecognition | null>(
		null
	)
	const mediaRecorderRef = useRef<MediaRecorder | null>(
		null
	)
	const streamRef = useRef<MediaStream | null>(null)
	const audioChunksRef = useRef<Blob[]>([])
	const onTranscriptionChangeRef = useRef(
		onTranscriptionChange
	)
	const onAudioRecordedRef = useRef(onAudioRecorded)

	onTranscriptionChangeRef.current = onTranscriptionChange
	onAudioRecordedRef.current = onAudioRecorded

	useEffect(() => {
		if (mode !== 'speech-recognition') return

		const SpeechRecognition =
			window.SpeechRecognition ||
			window.webkitSpeechRecognition
		const speechRecognition = new SpeechRecognition()

		speechRecognition.continuous = true
		speechRecognition.interimResults = true
		speechRecognition.lang = lang

		const handleStart = () => setIsListening(true)
		const handleEnd = () => setIsListening(false)
		const handleResult = (event: Event) => {
			const speechEvent = event as SpeechRecognitionEvent
			let finalTranscript = ''
			for (
				let i = speechEvent.resultIndex;
				i < speechEvent.results.length;
				i += 1
			) {
				const result = speechEvent.results[i]
				if (result.isFinal) {
					finalTranscript += result[0]?.transcript ?? ''
				}
			}
			if (finalTranscript) {
				onTranscriptionChangeRef.current?.(finalTranscript)
			}
		}
		const handleError = () => setIsListening(false)

		speechRecognition.addEventListener('start', handleStart)
		speechRecognition.addEventListener('end', handleEnd)
		speechRecognition.addEventListener(
			'result',
			handleResult
		)
		speechRecognition.addEventListener('error', handleError)

		recognitionRef.current = speechRecognition
		setIsRecognitionReady(true)

		return () => {
			speechRecognition.removeEventListener(
				'start',
				handleStart
			)
			speechRecognition.removeEventListener(
				'end',
				handleEnd
			)
			speechRecognition.removeEventListener(
				'result',
				handleResult
			)
			speechRecognition.removeEventListener(
				'error',
				handleError
			)
			speechRecognition.stop()
			recognitionRef.current = null
			setIsRecognitionReady(false)
		}
	}, [mode, lang])

	useEffect(
		() => () => {
			if (mediaRecorderRef.current?.state === 'recording')
				mediaRecorderRef.current.stop()
			if (streamRef.current)
				for (const track of streamRef.current.getTracks())
					track.stop()
		},
		[]
	)

	const startMediaRecorder = useCallback(async () => {
		if (!onAudioRecordedRef.current) return
		try {
			const stream =
				await navigator.mediaDevices.getUserMedia({
					audio: true
				})
			streamRef.current = stream
			const mediaRecorder = new MediaRecorder(stream)
			audioChunksRef.current = []

			mediaRecorder.addEventListener(
				'dataavailable',
				(event: BlobEvent) => {
					if (event.data.size > 0)
						audioChunksRef.current.push(event.data)
				}
			)

			mediaRecorder.addEventListener('stop', async () => {
				for (const track of stream.getTracks()) track.stop()
				streamRef.current = null
				const audioBlob = new Blob(audioChunksRef.current, {
					type: 'audio/webm'
				})
				if (
					audioBlob.size === 0 ||
					!onAudioRecordedRef.current
				)
					return
				setIsProcessing(true)
				try {
					const transcript =
						await onAudioRecordedRef.current(audioBlob)
					if (transcript)
						onTranscriptionChangeRef.current?.(transcript)
				} catch {
					// delegated to caller
				} finally {
					setIsProcessing(false)
				}
			})

			mediaRecorder.addEventListener('error', () => {
				setIsListening(false)
				for (const track of stream.getTracks()) track.stop()
				streamRef.current = null
			})

			mediaRecorderRef.current = mediaRecorder
			mediaRecorder.start()
			setIsListening(true)
		} catch (err) {
			console.error(
				'[MicRecordButton] Failed to start recording:',
				err
			)
			setIsListening(false)
		}
	}, [])

	const stopMediaRecorder = useCallback(() => {
		if (mediaRecorderRef.current?.state === 'recording')
			mediaRecorderRef.current.stop()
		setIsListening(false)
	}, [])

	const toggleListening = useCallback(() => {
		if (
			mode === 'speech-recognition' &&
			recognitionRef.current
		) {
			if (isListening) recognitionRef.current.stop()
			else recognitionRef.current.start()
			return
		}
		if (mode === 'media-recorder') {
			if (isListening) stopMediaRecorder()
			else startMediaRecorder()
		}
	}, [
		mode,
		isListening,
		startMediaRecorder,
		stopMediaRecorder
	])

	const isDisabled =
		mode === 'none' ||
		(mode === 'speech-recognition' &&
			!isRecognitionReady) ||
		(mode === 'media-recorder' && !onAudioRecorded) ||
		isProcessing

	return (
		<div
			className={cn(
				'relative inline-flex items-center justify-center',
				className
			)}
		>
			{/* Pulsing rings — soft red waves that emanate outward */}
			<AnimatePresence>
				{isListening &&
					[0, 1, 2].map(i => (
						<motion.div
							key={i}
							className="pointer-events-none absolute inset-[-4px] rounded-full border border-primary/50"
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{
								opacity: [0, 0.4, 0],
								scale: [0.9, 1.25, 1.55]
							}}
							exit={{
								opacity: 0,
								scale: 0.9,
								transition: {
									duration: 0.12,
									ease: 'easeOut'
								}
							}}
							transition={{
								duration: 2.2,
								delay: i * 0.35,
								repeat: Number.POSITIVE_INFINITY,
								ease: 'easeOut'
							}}
						/>
					))}
			</AnimatePresence>

			{/* Main button — mimics the search toggle style */}
			<button
				type="button"
				onClick={toggleListening}
				disabled={isDisabled}
				className={cn(
					'relative z-10 flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-1.5 py-1 transition-colors duration-200',
					isListening
						? 'border-primary bg-primary/15 text-primary'
						: 'border-transparent bg-black/5 text-muted-foreground hover:text-foreground dark:bg-white/5',
					isDisabled && 'pointer-events-none opacity-50'
				)}
			>
				{/* Icon container with spring hover */}
				<div className="flex size-4 shrink-0 items-center justify-center">
					<motion.div
						animate={{
							scale: isListening ? 1.1 : 1
						}}
						whileHover={{
							rotate: isListening ? 0 : -15,
							scale: 1.15,
							transition: {
								type: 'spring',
								stiffness: 300,
								damping: 10
							}
						}}
						transition={{
							type: 'spring',
							stiffness: 260,
							damping: 25
						}}
					>
						<AnimatePresence mode="popLayout">
							{isProcessing ? (
								<motion.div
									key="spinner"
									initial={{ opacity: 0, scale: 0.5 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{
										opacity: 0,
										scale: 0.5,
										transition: { duration: 0.1 }
									}}
									transition={{ duration: 0.12 }}
								>
									<Spinner className="size-4" />
								</motion.div>
							) : isListening ? (
								<motion.div
									key="stop"
									initial={{ opacity: 0, scale: 0.6 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{
										opacity: 0,
										scale: 0.5,
										transition: { duration: 0.1 }
									}}
									transition={{ duration: 0.12 }}
								>
									<StopIcon
										weight="fill"
										className="size-4 text-primary"
									/>
								</motion.div>
							) : (
								<motion.div
									key="mic"
									initial={{ opacity: 0, scale: 0.6 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{
										opacity: 0,
										scale: 0.5,
										transition: { duration: 0.1 }
									}}
									transition={{ duration: 0.12 }}
								>
									<MicIcon className="size-4" />
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				</div>

				{/* Expanding "Recording" label — mirrors the search button's text expand */}
				<AnimatePresence>
					{isListening && (
						<motion.span
							initial={{ width: 0, opacity: 0 }}
							animate={{ width: 'auto', opacity: 1 }}
							exit={{ width: 0, opacity: 0 }}
							transition={{ duration: 0.2 }}
							className="shrink-0 overflow-hidden whitespace-nowrap text-sm text-primary"
						>
							Recording
						</motion.span>
					)}
				</AnimatePresence>
			</button>
		</div>
	)
}
