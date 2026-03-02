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

interface SessionEntry {
	id: string
	createdAt: number
	updatedAt: number
	currentSeq: number
}

interface SessionListProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	listSessions: () => Promise<unknown>
	onResume: (sessionId: string) => Promise<void>
	currentSessionId?: string
}

export function SessionList({
	open,
	onOpenChange,
	listSessions,
	onResume,
	currentSessionId
}: SessionListProps) {
	const {
		data: sessions = [],
		isLoading: loading,
		error: queryError
	} = useQuery({
		queryKey: ['sessions'],
		queryFn: () =>
			listSessions() as Promise<SessionEntry[]>,
		enabled: open
	})

	const [resumeError, setResumeError] = useState<
		string | null
	>(null)
	const error =
		resumeError ?? (queryError ? String(queryError) : null)

	const handleResume = async (session: SessionEntry) => {
		try {
			setResumeError(null)
			await onResume(session.id)
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
						Sessions
					</CredenzaTitle>
					<CredenzaDescription className="text-xs">
						Switch between conversation sessions
					</CredenzaDescription>
				</CredenzaHeader>

				<CredenzaBody className="overflow-y-auto min-h-0">
					{loading && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							Loading sessions...
						</p>
					)}
					{error && (
						<p className="py-8 text-center text-sm text-destructive">
							{error}
						</p>
					)}
					{!loading && sessions.length === 0 && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							No sessions found.
						</p>
					)}
					{!loading && sessions.length > 0 && (
						<div className="space-y-1 pr-2">
							{sessions.map(session => {
								const isCurrent =
									session.id === currentSessionId
								return (
									<button
										key={session.id}
										type="button"
										onClick={() => handleResume(session)}
										className={cn(
											'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12px] transition-colors hover:bg-accent',
											isCurrent && 'bg-primary/5'
										)}
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-medium truncate font-mono text-[11px]">
													{session.id.slice(0, 8)}
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
														new Date(session.createdAt)
													)}
												</span>
												<span>
													{session.currentSeq} events
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
