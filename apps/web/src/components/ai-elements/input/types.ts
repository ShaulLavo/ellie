import type { RefObject } from 'react'
import type {
	ChatStatus,
	FileUIPart,
	SourceDocumentUIPart
} from '../types'

export interface AttachmentsContext {
	files: (FileUIPart & { id: string })[]
	add: (files: File[] | FileList) => void
	remove: (id: string) => void
	clear: () => void
	openFileDialog: () => void
	fileInputRef: RefObject<HTMLInputElement | null>
}

export interface TextInputContext {
	value: string
	setInput: (v: string) => void
	clear: () => void
}

export interface PromptInputControllerProps {
	textInput: TextInputContext
	attachments: AttachmentsContext
	/** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
	__registerFileInput: (
		ref: RefObject<HTMLInputElement | null>,
		open: () => void
	) => void
}

export interface ReferencedSourcesContext {
	sources: (SourceDocumentUIPart & { id: string })[]
	add: (
		sources: SourceDocumentUIPart[] | SourceDocumentUIPart
	) => void
	remove: (id: string) => void
	clear: () => void
}

export interface PromptInputMessage {
	text: string
	files: FileUIPart[]
}

export type { ChatStatus, FileUIPart, SourceDocumentUIPart }
