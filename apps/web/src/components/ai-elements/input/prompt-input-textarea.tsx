import type {
	ChangeEvent,
	ClipboardEventHandler,
	ComponentProps,
	KeyboardEventHandler
} from 'react'
import { useState } from 'react'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'
import {
	useOptionalPromptInputController,
	usePromptInputAttachments
} from './contexts'

export type PromptInputTextareaProps = ComponentProps<
	typeof InputGroupTextarea
>

export const PromptInputTextarea = ({
	onChange,
	onKeyDown,
	className,
	placeholder = 'What would you like to know?',
	...props
}: PromptInputTextareaProps) => {
	const controller = useOptionalPromptInputController()
	const attachments = usePromptInputAttachments()
	const [isComposing, setIsComposing] = useState(false)

	const handleKeyDown: KeyboardEventHandler<
		HTMLTextAreaElement
	> = e => {
		onKeyDown?.(e)

		if (e.defaultPrevented) return

		if (e.key === 'Enter') {
			if (isComposing || e.nativeEvent.isComposing) return
			if (e.shiftKey) return
			e.preventDefault()

			const { form } = e.currentTarget
			const submitButton = form?.querySelector(
				'button[type="submit"]'
			) as HTMLButtonElement | null
			if (submitButton?.disabled) return

			form?.requestSubmit()
		}

		if (
			e.key === 'Backspace' &&
			e.currentTarget.value === '' &&
			attachments.files.length > 0
		) {
			e.preventDefault()
			const lastAttachment = attachments.files.at(-1)
			if (lastAttachment) {
				attachments.remove(lastAttachment.id)
			}
		}
	}

	const handlePaste: ClipboardEventHandler<
		HTMLTextAreaElement
	> = event => {
		const items = event.clipboardData?.items
		if (!items) return

		const files: File[] = []

		for (const item of items) {
			if (item.kind !== 'file') continue
			const file = item.getAsFile()
			if (file) files.push(file)
		}

		if (files.length > 0) {
			event.preventDefault()
			attachments.add(files)
			return
		}

		const LONG_PASTE_THRESHOLD = 1024
		const pastedText =
			event.clipboardData?.getData('text/plain')
		if (
			pastedText &&
			pastedText.length > LONG_PASTE_THRESHOLD
		) {
			event.preventDefault()
			const blob = new Blob([pastedText], {
				type: 'text/plain'
			})
			const file = new File([blob], 'Pasted text.txt', {
				type: 'text/plain'
			})
			attachments.add([file])
		}
	}

	const controlledProps = controller
		? {
				onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
					controller.textInput.setInput(
						e.currentTarget.value
					)
					onChange?.(e)
				},
				value: controller.textInput.value
			}
		: { onChange }

	return (
		<InputGroupTextarea
			className={cn(
				'field-sizing-content max-h-48 min-h-16',
				className
			)}
			name="message"
			onCompositionEnd={() => setIsComposing(false)}
			onCompositionStart={() => setIsComposing(true)}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			placeholder={placeholder}
			{...props}
			{...controlledProps}
		/>
	)
}
