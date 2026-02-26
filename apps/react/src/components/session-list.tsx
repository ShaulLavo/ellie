import { useEffect, useState } from 'react'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaDescription,
	CredenzaBody
} from '@/components/ui/credenza'
import { Badge } from '@/components/ui/badge'
import { ListIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SessionEntry {
	date: string
	session: number
	name: string | null
	status: string
	lineCount: number | null
	sizeBytes: number | null
	createdAt: number
}

interface SessionListProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	listSessions: () => Promise<unknown>
	onResume: (date: string, session: number) => Promise<void>
}

function formatSize(bytes: number | null): string {
	if (!bytes) return '—'
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024)
		return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function SessionList({
	open,
	onOpenChange,
	listSessions,
	onResume
}: SessionListProps) {
	const [sessions, setSessions] = useState<SessionEntry[]>(
		[]
	)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) return
		let cancelled = false
		setLoading(true)
		setError(null)
		;(async () => {
			try {
				const data = await listSessions()
				if (!cancelled) setSessions(data as SessionEntry[])
			} catch (err) {
				if (!cancelled) setError(String(err))
			} finally {
				if (!cancelled) setLoading(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [open, listSessions])

	const handleResume = async (session: SessionEntry) => {
		try {
			await onResume(session.date, session.session)
			onOpenChange(false)
		} catch (err) {
			setError(String(err))
		}
	}

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-lg max-h-[80vh] !grid-rows-[auto_1fr]">
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
							{sessions.map(session => (
								<button
									key={`${session.date}-${session.session}`}
									type="button"
									onClick={() => handleResume(session)}
									className={cn(
										'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12px] transition-colors hover:bg-accent',
										session.status === 'active' &&
											'bg-primary/5'
									)}
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">
												{session.name ??
													`Session ${session.session}`}
											</span>
											<Badge
												variant={
													session.status === 'active'
														? 'default'
														: 'secondary'
												}
												className="text-[9px] px-1 py-0"
											>
												{session.status}
											</Badge>
										</div>
										<div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
											<span>{session.date}</span>
											<span>
												{session.lineCount ?? 0} entries
											</span>
											<span>
												{formatSize(session.sizeBytes)}
											</span>
										</div>
									</div>
								</button>
							))}
						</div>
					)}
				</CredenzaBody>
			</CredenzaContent>
		</Credenza>
	)
}
