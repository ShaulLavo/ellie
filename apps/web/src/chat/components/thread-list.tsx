import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaDescription,
	CredenzaBody
} from '@/components/ui/credenza'
import { ListIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@ellie/utils'

interface ThreadEntry {
	id: string
	createdAt: number
	updatedAt: number
	currentSeq: number
}

interface ThreadListProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	listThreads: () => Promise<unknown>
	onResume: (threadId: string) => Promise<void>
	currentThreadId?: string
}

export function ThreadList({
	open,
	onOpenChange,
	listThreads,
	onResume,
	currentThreadId
}: ThreadListProps) {
	const {
		data: threads = [],
		isLoading: loading,
		error: queryError
	} = useQuery({
		queryKey: ['threads'],
		queryFn: () => listThreads() as Promise<ThreadEntry[]>,
		enabled: open
	})

	const [resumeError, setResumeError] = useState<
		string | null
	>(null)
	const error =
		resumeError ?? (queryError ? String(queryError) : null)

	const handleResume = async (thread: ThreadEntry) => {
		try {
			setResumeError(null)
			await onResume(thread.id)
			onOpenChange(false)
		} catch (err) {
			setResumeError(String(err))
		}
	}

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-lg max-h-[80vh] grid-rows-[auto_1fr]!">
				<CredenzaHeader>
					<CredenzaTitle className="flex items-center gap-2 text-sm">
						<ListIcon className="size-4" />
						Threads
					</CredenzaTitle>
					<CredenzaDescription className="text-xs">
						Switch between conversation threads
					</CredenzaDescription>
				</CredenzaHeader>

				<CredenzaBody className="overflow-y-auto min-h-0">
					{loading && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							Loading threads...
						</p>
					)}
					{error && (
						<p className="py-8 text-center text-sm text-destructive">
							{error}
						</p>
					)}
					{!loading && threads.length === 0 && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							No threads found.
						</p>
					)}
					{!loading && threads.length > 0 && (
						<div className="space-y-1 pr-2">
							{threads.map(thread => {
								const isCurrent =
									thread.id === currentThreadId
								return (
									<button
										key={thread.id}
										type="button"
										onClick={() => handleResume(thread)}
										className={cn(
											'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12px] transition-colors hover:bg-accent',
											isCurrent && 'bg-primary/5'
										)}
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-medium truncate font-mono text-[11px]">
													{thread.id.slice(0, 8)}
												</span>
												{isCurrent && (
													<span className="text-[9px] px-1 py-0 rounded bg-primary/10 text-primary">
														current
													</span>
												)}
											</div>
											<div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
												<span>
													{formatDateTime(
														new Date(thread.createdAt)
													)}
												</span>
												<span>
													{thread.currentSeq} events
												</span>
											</div>
										</div>
									</button>
								)
							})}
						</div>
					)}
				</CredenzaBody>
			</CredenzaContent>
		</Credenza>
	)
}
