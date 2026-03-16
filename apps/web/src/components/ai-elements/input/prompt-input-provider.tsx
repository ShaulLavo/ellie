import type { PropsWithChildren } from 'react'
import type { FileUIPart } from './types'
import type {
	AttachmentsContext,
	PromptInputControllerProps
} from './types'
import {
	PromptInputController,
	ProviderAttachmentsContext
} from './contexts'
import {
	useState,
	useRef,
	useEffect,
	type RefObject
} from 'react'
import { nanoid } from 'nanoid'

export type PromptInputProviderProps = PropsWithChildren<{
	initialInput?: string
}>

export const PromptInputProvider = ({
	initialInput: initialTextInput = '',
	children
}: PromptInputProviderProps) => {
	const [textInput, setTextInput] = useState(
		initialTextInput
	)
	const clearInput = () => setTextInput('')

	const [attachmentFiles, setAttachmentFiles] = useState<
		(FileUIPart & { id: string })[]
	>([])
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	// oxlint-disable-next-line eslint(no-empty-function)
	const openRef = useRef<() => void>(() => {})

	const add = (files: File[] | FileList) => {
		const incoming = [...files]
		if (incoming.length === 0) return

		setAttachmentFiles(prev => [
			...prev,
			...incoming.map(file => ({
				filename: file.name,
				id: nanoid(),
				mediaType: file.type,
				type: 'file' as const,
				url: URL.createObjectURL(file),
				rawFile: file
			}))
		])
	}

	const remove = (id: string) => {
		setAttachmentFiles(prev => {
			const found = prev.find(f => f.id === id)
			if (found?.url) URL.revokeObjectURL(found.url)
			return prev.filter(f => f.id !== id)
		})
	}

	const clear = () => {
		setAttachmentFiles(prev => {
			for (const f of prev) {
				if (f.url) URL.revokeObjectURL(f.url)
			}
			return []
		})
	}

	const attachmentsRef = useRef(attachmentFiles)

	useEffect(() => {
		attachmentsRef.current = attachmentFiles
	}, [attachmentFiles])

	useEffect(
		() => () => {
			for (const f of attachmentsRef.current) {
				if (f.url) URL.revokeObjectURL(f.url)
			}
		},
		[]
	)

	const openFileDialog = () => openRef.current?.()

	const attachments: AttachmentsContext = {
		add,
		clear,
		fileInputRef,
		files: attachmentFiles,
		openFileDialog,
		remove
	}

	const __registerFileInput = (
		ref: RefObject<HTMLInputElement | null>,
		open: () => void
	) => {
		fileInputRef.current = ref.current
		openRef.current = open
	}

	const controller: PromptInputControllerProps = {
		__registerFileInput,
		attachments,
		textInput: {
			clear: clearInput,
			setInput: setTextInput,
			value: textInput
		}
	}

	return (
		<PromptInputController.Provider value={controller}>
			<ProviderAttachmentsContext.Provider
				value={attachments}
			>
				{children}
			</ProviderAttachmentsContext.Provider>
		</PromptInputController.Provider>
	)
}
