import { createContext, useContext } from 'react'
import type {
	AttachmentsContext,
	PromptInputControllerProps,
	ReferencedSourcesContext
} from './types'

export const PromptInputController =
	createContext<PromptInputControllerProps | null>(null)
export const ProviderAttachmentsContext =
	createContext<AttachmentsContext | null>(null)
export const LocalAttachmentsContext =
	createContext<AttachmentsContext | null>(null)
export const LocalReferencedSourcesContext =
	createContext<ReferencedSourcesContext | null>(null)

export const usePromptInputController = () => {
	const ctx = useContext(PromptInputController)
	if (!ctx) {
		throw new Error(
			'Wrap your component inside <PromptInputProvider> to use usePromptInputController().'
		)
	}
	return ctx
}

export const useOptionalPromptInputController = () =>
	useContext(PromptInputController)

export const useProviderAttachments = () => {
	const ctx = useContext(ProviderAttachmentsContext)
	if (!ctx) {
		throw new Error(
			'Wrap your component inside <PromptInputProvider> to use useProviderAttachments().'
		)
	}
	return ctx
}

export const useOptionalProviderAttachments = () =>
	useContext(ProviderAttachmentsContext)

export const usePromptInputAttachments = () => {
	const provider = useOptionalProviderAttachments()
	const local = useContext(LocalAttachmentsContext)
	const context = local ?? provider
	if (!context) {
		throw new Error(
			'usePromptInputAttachments must be used within a PromptInput or PromptInputProvider'
		)
	}
	return context
}

export const usePromptInputReferencedSources = () => {
	const ctx = useContext(LocalReferencedSourcesContext)
	if (!ctx) {
		throw new Error(
			'usePromptInputReferencedSources must be used within a LocalReferencedSourcesContext.Provider'
		)
	}
	return ctx
}
