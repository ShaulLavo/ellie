import { memo, useMemo } from 'react'
import { CheckCircle as CheckCircleIcon, XCircle as XCircleIcon } from '@phosphor-icons/react'
import Ansi from 'ansi-to-react'
import { cn } from '@/lib/utils'
import {
	Terminal,
	TerminalHeader,
	TerminalTitle,
	TerminalCopyButton,
	TerminalContent
} from './terminal'
import { ToolOutput } from './tool'

interface ShellResult {
	exitCode: number
	stdout: string
	stderr: string
	error?: string
}

function parseShellResult(result: string): ShellResult | null {
	try {
		const parsed = JSON.parse(result)
		if (typeof parsed === 'object' && parsed !== null && 'exitCode' in parsed) {
			return parsed as ShellResult
		}
		return null
	} catch {
		return null
	}
}

interface ShellOutputProps {
	command: string
	result: string
	className?: string
}

export const ShellOutput = memo(function ShellOutput({
	command,
	result,
	className
}: ShellOutputProps) {
	const parsed = useMemo(() => parseShellResult(result), [result])

	const fullOutput = useMemo(() => {
		if (!parsed) return null
		const { stdout, stderr, error } = parsed
		const stderrText = stderr || error || ''
		let text = `$ ${command}\n`
		if (stdout) text += stdout
		if (stderrText) {
			if (stdout && !stdout.endsWith('\n')) text += '\n'
			text += stderrText
		}
		return text
	}, [command, parsed])

	if (!parsed) {
		return <ToolOutput output={result} errorText={undefined} />
	}

	const { exitCode, stdout, stderr, error } = parsed
	const stderrText = stderr || error || ''

	return (
		<div className={cn('space-y-2', className)}>
			<div className="flex items-center gap-2">
				<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Output
				</h4>
				<ExitCodeBadge exitCode={exitCode} />
			</div>
			<Terminal output={fullOutput ?? ''}>
				<TerminalHeader>
					<TerminalTitle />
					<TerminalCopyButton />
				</TerminalHeader>
				<TerminalContent>
					<pre className="whitespace-pre-wrap break-words">
						<span className="text-green-400">$ </span>
						<span className="text-zinc-100">{command}</span>
						{'\n'}
						{stdout && <Ansi>{stdout}</Ansi>}
						{stderrText && (
							<span className="text-red-400">
								<Ansi>{stderrText}</Ansi>
							</span>
						)}
					</pre>
				</TerminalContent>
			</Terminal>
		</div>
	)
})

const ExitCodeBadge = ({ exitCode }: { exitCode: number }) => (
	<span
		className={cn(
			'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono',
			exitCode === 0 ? 'bg-muted text-muted-foreground' : 'bg-red-500/10 text-red-600'
		)}
	>
		{exitCode === 0 ? <CheckCircleIcon className="size-3" /> : <XCircleIcon className="size-3" />}
		exit {exitCode}
	</span>
)
