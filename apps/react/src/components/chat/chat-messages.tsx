import { cn } from "@/lib/utils";

export interface ChatMessagesProps extends React.ComponentProps<"div"> {}

export function ChatMessages({
  children,
  className,
  ...props
}: ChatMessagesProps) {
  return (
    <div
      className={cn(
        "flex-1 flex flex-col-reverse overflow-auto py-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
