import type {
	ChangeEventHandler,
	FormEvent,
	FormEventHandler,
	HTMLAttributes
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { InputGroup } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'
import type {
	AttachmentsContext,
	FileUIPart,
	PromptInputMessage,
	ReferencedSourcesContext,
	SourceDocumentUIPart
} from './types'
import {
	LocalAttachmentsContext,
	LocalReferencedSourcesContext,
	useOptionalPromptInputController
} from './contexts'

export type PromptInputProps = Omit<
	HTMLAttributes<HTMLFormElement>,
	'onSubmit' | 'onError'
> & {
	accept?: string
	multiple?: boolean
	globalDrop?: boolean
	syncHiddenInput?: boolean
	maxFiles?: number
	maxFileSize?: number
	onError?: (err: {
		code: 'max_files' | 'max_file_size' | 'accept'
		message: string
	}) => void
	onSubmit: (
		message: PromptInputMessage,
		event: FormEvent<HTMLFormElement>
	) => void | Promise<void>
}

export const PromptInput = ({
	className,
	accept,
	multiple,
	globalDrop,
	syncHiddenInput,
	maxFiles,
	maxFileSize,
	onError,
	onSubmit,
	children,
	...props
}: PromptInputProps) => {
	const controller = useOptionalPromptInputController()
	const usingProvider = Boolean(controller)

	const inputRef = useRef<HTMLInputElement | null>(null)
	const formRef = useRef<HTMLFormElement | null>(null)

	const [items, setItems] = useState<
		(FileUIPart & { id: string })[]
	>([])
	const files = controller
		? controller.attachments.files
		: items

	const [referencedSources, setReferencedSources] =
		useState<(SourceDocumentUIPart & { id: string })[]>([])

	const filesRef = useRef(files)

	useEffect(() => {
		filesRef.current = files
	}, [files])

	const openFileDialogLocal = () =>
		inputRef.current?.click()

	const matchesAccept = (f: File) => {
		if (!accept || accept.trim() === '') return true

		const patterns = accept
			.split(',')
			.map(s => s.trim())
			.filter(Boolean)

		return patterns.some(pattern => {
			if (pattern.endsWith('/*')) {
				const prefix = pattern.slice(0, -1)
				return f.type.startsWith(prefix)
			}
			return f.type === pattern
		})
	}

	const validateFiles = (
		fileList: File[] | FileList,
		currentCount: number
	): File[] | null => {
		const incoming = [...fileList]
		const accepted = incoming.filter(f => matchesAccept(f))
		if (incoming.length && accepted.length === 0) {
			onError?.({
				code: 'accept',
				message: 'No files match the accepted types.'
			})
			return null
		}
		const withinSize = (f: File) =>
			maxFileSize ? f.size <= maxFileSize : true
		const sized = accepted.filter(withinSize)
		if (accepted.length > 0 && sized.length === 0) {
			onError?.({
				code: 'max_file_size',
				message: 'All files exceed the maximum size.'
			})
			return null
		}

		const capacity =
			typeof maxFiles === 'number'
				? Math.max(0, maxFiles - currentCount)
				: undefined
		const capped =
			typeof capacity === 'number'
				? sized.slice(0, capacity)
				: sized
		if (
			typeof capacity === 'number' &&
			sized.length > capacity
		) {
			onError?.({
				code: 'max_files',
				message: 'Too many files. Some were not added.'
			})
		}
		return capped
	}

	const addLocal = (fileList: File[] | FileList) => {
		setItems(prev => {
			const capped = validateFiles(fileList, prev.length)
			if (!capped || capped.length === 0) return prev
			const next: (FileUIPart & { id: string })[] = []
			for (const file of capped) {
				next.push({
					filename: file.name,
					id: nanoid(),
					mediaType: file.type,
					type: 'file',
					url: URL.createObjectURL(file),
					rawFile: file
				})
			}
			return [...prev, ...next]
		})
	}

	const removeLocal = (id: string) =>
		setItems(prev => {
			const found = prev.find(file => file.id === id)
			if (found?.url) URL.revokeObjectURL(found.url)
			return prev.filter(file => file.id !== id)
		})

	const addWithProviderValidation = (
		fileList: File[] | FileList
	) => {
		const capped = validateFiles(fileList, files.length)
		if (capped && capped.length > 0) {
			controller?.attachments.add(capped)
		}
	}

	const clearAttachments = () =>
		usingProvider
			? controller?.attachments.clear()
			: setItems(prev => {
					for (const file of prev) {
						if (file.url) URL.revokeObjectURL(file.url)
					}
					return []
				})

	const clearReferencedSources = () =>
		setReferencedSources([])

	const add = controller
		? addWithProviderValidation
		: addLocal
	const remove = controller
		? controller.attachments.remove
		: removeLocal
	const openFileDialog = controller
		? controller.attachments.openFileDialog
		: openFileDialogLocal

	const clear = () => {
		clearAttachments()
		clearReferencedSources()
	}

	useEffect(() => {
		if (!controller) return
		controller.__registerFileInput(inputRef, () =>
			inputRef.current?.click()
		)
	}, [controller])

	useEffect(() => {
		if (
			syncHiddenInput &&
			inputRef.current &&
			files.length === 0
		) {
			inputRef.current.value = ''
		}
	}, [files, syncHiddenInput])

	useEffect(() => {
		const target = globalDrop ? document : formRef.current
		if (!target) return

		const onDragOver = (e: Event) => {
			if (
				(e as DragEvent).dataTransfer?.types?.includes(
					'Files'
				)
			) {
				e.preventDefault()
			}
		}
		const onDrop = (e: Event) => {
			const de = e as DragEvent
			if (de.dataTransfer?.types?.includes('Files')) {
				e.preventDefault()
			}
			if (
				de.dataTransfer?.files &&
				de.dataTransfer.files.length > 0
			) {
				add(de.dataTransfer.files)
			}
		}
		target.addEventListener('dragover', onDragOver)
		target.addEventListener('drop', onDrop)
		return () => {
			target.removeEventListener('dragover', onDragOver)
			target.removeEventListener('drop', onDrop)
		}
	}, [add, globalDrop])

	useEffect(
		() => () => {
			if (usingProvider) return
			for (const f of filesRef.current) {
				if (f.url) URL.revokeObjectURL(f.url)
			}
		},
		[usingProvider]
	)

	const handleChange: ChangeEventHandler<
		HTMLInputElement
	> = event => {
		if (event.currentTarget.files) {
			add(event.currentTarget.files)
		}
		event.currentTarget.value = ''
	}

	const attachmentsCtx: AttachmentsContext = {
		add,
		clear: clearAttachments,
		fileInputRef: inputRef,
		files: files.map(item => ({ ...item, id: item.id })),
		openFileDialog,
		remove
	}

	const refsCtx: ReferencedSourcesContext = {
		add: (
			incoming:
				| SourceDocumentUIPart[]
				| SourceDocumentUIPart
		) => {
			const array = Array.isArray(incoming)
				? incoming
				: [incoming]
			setReferencedSources(prev => [
				...prev,
				...array.map(s => ({ ...s, id: nanoid() }))
			])
		},
		clear: clearReferencedSources,
		remove: (id: string) => {
			setReferencedSources(prev =>
				prev.filter(s => s.id !== id)
			)
		},
		sources: referencedSources
	}

	const isSubmittingRef = useRef(false)

	const handleSubmit: FormEventHandler<
		HTMLFormElement
	> = async event => {
		event.preventDefault()

		if (isSubmittingRef.current) return
		isSubmittingRef.current = true

		const form = event.currentTarget
		function getFormText() {
			const formData = new FormData(form)
			return (formData.get('message') as string) || ''
		}

		const text = controller
			? controller.textInput.value
			: getFormText()

		controller?.textInput.clear()

		if (!usingProvider) {
			form.reset()
		}

		try {
			const convertedFiles: FileUIPart[] = files.map(
				({ id: _id, ...item }) => item
			)

			const result = onSubmit(
				{ files: convertedFiles, text },
				event
			)

			if (result instanceof Promise) {
				try {
					await result
				} catch {
					isSubmittingRef.current = false
					return
				}
			}

			clear()
		} catch {
			// Don't clear on error
		}
		isSubmittingRef.current = false
	}

	const inner = (
		<>
			<input
				accept={accept}
				aria-label="Upload files"
				className="hidden"
				multiple={multiple}
				onChange={handleChange}
				ref={inputRef}
				title="Upload files"
				type="file"
			/>
			<form
				className={cn('w-full', className)}
				onSubmit={handleSubmit}
				ref={formRef}
				{...props}
			>
				<InputGroup className="overflow-hidden">
					{children}
				</InputGroup>
			</form>
		</>
	)

	const withReferencedSources = (
		<LocalReferencedSourcesContext.Provider value={refsCtx}>
			{inner}
		</LocalReferencedSourcesContext.Provider>
	)

	return (
		<LocalAttachmentsContext.Provider
			value={attachmentsCtx}
		>
			{withReferencedSources}
		</LocalAttachmentsContext.Provider>
	)
}
