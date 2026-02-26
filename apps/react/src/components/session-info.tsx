import { useEffect, useState } from 'react'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaBody
} from '@/components/ui/credenza'
import { NumberTicker } from '@/components/ui/number-ticker'
import {
	InfoIcon,
	GitBranchIcon,
	FileTextIcon,
	HardDriveIcon
} from 'lucide-react'

interface SessionStats {
	date: string
	session: number
	name: string | null
	entryCount: number
	branchCount: number
	leafId: string | null
	sizeBytes: number
}

interface SessionInfoProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	getSessionStats: () => Promise<unknown>
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024)
		return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SessionInfo({
	open,
	onOpenChange,
	getSessionStats
}: SessionInfoProps) {
	const [stats, setStats] = useState<SessionStats | null>(
		null
	)
	const [loading, setLoading] = useState(false)

	useEffect(() => {
		if (!open) return
		setLoading(true)
		;(async () => {
			try {
				const data = await getSessionStats()
				setStats(data as SessionStats)
			} catch {
				/* ignore */
			} finally {
				setLoading(false)
			}
		})()
	}, [open, getSessionStats])

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-sm">
				<CredenzaHeader>
					<CredenzaTitle className="flex items-center gap-2 text-sm">
						<InfoIcon className="size-4" />
						Session Info
					</CredenzaTitle>
				</CredenzaHeader>

				<CredenzaBody>
					{loading && (
						<p className="py-4 text-center text-sm text-muted-foreground">
							Loading...
						</p>
					)}

					{stats && !loading && (
						<div className="space-y-3 text-[12px]">
							{stats.name && (
								<div>
									<span className="text-muted-foreground">
										Name
									</span>
									<p className="font-medium">
										{stats.name}
									</p>
								</div>
							)}
							<div className="grid grid-cols-2 gap-3">
								<div className="flex items-center gap-2">
									<FileTextIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Entries
										</p>
										<p className="font-medium">
											<NumberTicker
												value={stats.entryCount}
												className="text-inherit"
											/>
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<GitBranchIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Branches
										</p>
										<p className="font-medium">
											<NumberTicker
												value={stats.branchCount}
												className="text-inherit"
											/>
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<HardDriveIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Size
										</p>
										<p className="font-medium">
											{formatSize(stats.sizeBytes)}
										</p>
									</div>
								</div>
								<div>
									<p className="text-muted-foreground">
										Date
									</p>
									<p className="font-medium">
										{stats.date}
									</p>
								</div>
							</div>
							{stats.leafId && (
								<div>
									<span className="text-muted-foreground">
										Active leaf
									</span>
									<p className="font-mono text-[10px] text-muted-foreground/70 truncate">
										{stats.leafId}
									</p>
								</div>
							)}
						</div>
					)}
				</CredenzaBody>
			</CredenzaContent>
		</Credenza>
	)
}
