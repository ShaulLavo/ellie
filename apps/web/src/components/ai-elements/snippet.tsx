'use client'

import type { ComponentProps } from 'react'

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupText
} from '@/components/ui/input-group'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { createContext, useContext } from 'react'

interface SnippetContextType {
	code: string
}

const SnippetContext = createContext<SnippetContextType>({
	code: ''
})

export type SnippetProps = ComponentProps<
	typeof InputGroup
> & {
	code: string
}

export const Snippet = ({
	code,
	className,
	children,
	...props
}: SnippetProps) => (
	<SnippetContext.Provider value={{ code }}>
		<InputGroup
			className={cn('font-mono', className)}
			{...props}
		>
			{children}
		</InputGroup>
	</SnippetContext.Provider>
)

export type SnippetAddonProps = ComponentProps<
	typeof InputGroupAddon
>

export const SnippetAddon = (props: SnippetAddonProps) => (
	<InputGroupAddon {...props} />
)

export type SnippetTextProps = ComponentProps<
	typeof InputGroupText
>

export const SnippetText = ({
	className,
	...props
}: SnippetTextProps) => (
	<InputGroupText
		className={cn(
			'pl-2 font-normal text-muted-foreground',
			className
		)}
		{...props}
	/>
)

export type SnippetInputProps = Omit<
	ComponentProps<typeof InputGroupInput>,
	'readOnly' | 'value'
>

export const SnippetInput = ({
	className,
	...props
}: SnippetInputProps) => {
	const { code } = useContext(SnippetContext)

	return (
		<InputGroupInput
			className={cn('text-foreground', className)}
			readOnly
			value={code}
			{...props}
		/>
	)
}

export type SnippetCopyButtonProps = ComponentProps<
	typeof InputGroupButton
> & {
	onCopy?: () => void
	onError?: (error: Error) => void
	timeout?: number
}

export const SnippetCopyButton = ({
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: SnippetCopyButtonProps) => {
	const { code } = useContext(SnippetContext)
	const { isCopied, copy } = useCopyToClipboard(code, {
		timeout,
		onCopy,
		onError
	})

	const Icon = isCopied ? CheckIcon : CopyIcon

	return (
		<InputGroupButton
			aria-label="Copy"
			className={className}
			onClick={copy}
			size="icon-sm"
			title="Copy"
			{...props}
		>
			{children ?? <Icon className="size-3.5" size={14} />}
		</InputGroupButton>
	)
}
