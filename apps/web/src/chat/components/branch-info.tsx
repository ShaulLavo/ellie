import { useQuery } from '@tanstack/react-query'
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
	HashIcon,
	ClockIcon,
	ActivityIcon
} from 'lucide-react'
import { formatDateTime } from '@ellie/utils'

interface BranchData {
	id: string
	createdAt: number
	updatedAt: number
	currentSeq: number
}

interface BranchInfoProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	getBranchStats: () => Promise<unknown>
}

export function BranchInfo({
	open,
	onOpenChange,
	getBranchStats
}: BranchInfoProps) {
	const { data: stats, isLoading: loading } = useQuery({
		queryKey: ['branch-stats', getBranchStats],
		queryFn: () => getBranchStats() as Promise<BranchData>,
		enabled: open
	})

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-sm">
				<CredenzaHeader>
					<CredenzaTitle className="flex items-center gap-2 text-sm">
						<InfoIcon className="size-4" />
						Branch Info
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
							<div>
								<span className="text-muted-foreground">
									ID
								</span>
								<p className="font-mono text-[11px] font-medium truncate">
									{stats.id}
								</p>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div className="flex items-center gap-2">
									<ActivityIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Events
										</p>
										<p className="font-medium">
											<NumberTicker
												value={stats.currentSeq}
												className="text-inherit"
											/>
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<ClockIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Created
										</p>
										<p className="font-medium">
											{formatDateTime(
												new Date(stats.createdAt)
											)}
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<HashIcon className="size-3.5 text-muted-foreground" />
									<div>
										<p className="text-muted-foreground">
											Updated
										</p>
										<p className="font-medium">
											{formatDateTime(
												new Date(stats.updatedAt)
											)}
										</p>
									</div>
								</div>
							</div>
						</div>
					)}
				</CredenzaBody>
			</CredenzaContent>
		</Credenza>
	)
}
