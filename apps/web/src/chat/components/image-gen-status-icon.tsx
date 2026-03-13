import { CheckCircleIcon, XCircleIcon } from 'lucide-react'
import { LoadingAnimation } from '@/components/kokonutui/ai-loading'

export function ImageGenStatusIcon({
	status
}: {
	status: 'running' | 'complete' | 'error' | (string & {})
}) {
	if (status === 'error') {
		return (
			<XCircleIcon className="size-4 text-destructive" />
		)
	}
	if (status === 'complete') {
		return (
			<CheckCircleIcon className="size-4 text-primary" />
		)
	}
	return (
		<LoadingAnimation className="size-4" progress={100} />
	)
}
