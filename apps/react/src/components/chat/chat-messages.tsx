import { forwardRef } from "react"
import { cn } from "@/lib/utils"

export type ChatMessagesProps = React.ComponentProps<"div">

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(
  function ChatMessages({ children, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex-1 flex flex-col-reverse overflow-auto py-2", className)}
        {...props}
      >
        {children}
      </div>
    )
  }
)
