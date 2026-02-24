import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { StickToBottom } from 'use-stick-to-bottom'

export type ChatMessagesProps = React.ComponentProps<'div'>

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(function ChatMessages(
	{ children, className, ...props },
	ref
) {
	return (
		<StickToBottom className="relative flex-1 overflow-y-hidden" initial="smooth" resize="smooth">
			<StickToBottom.Content>
				<div ref={ref} className={cn('flex flex-col py-2', className)} {...props}>
					{children}
				</div>
			</StickToBottom.Content>
		</StickToBottom>
	)
})
