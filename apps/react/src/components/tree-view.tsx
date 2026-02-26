import {
	useCallback,
	useEffect,
	useRef,
	useState
} from 'react'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaDescription,
	CredenzaFooter,
	CredenzaBody
} from '@/components/ui/credenza'
import { Button } from '@/components/ui/button'
import {
	GitBranchIcon,
	MessageSquareIcon,
	BotIcon,
	ChevronRightIcon,
	ArrowRightIcon,
	GitForkIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface TreeEntry {
	id: string
	ts: number
	type: string
	line: number
	payload: { parts: Array<{ type: string; text?: string }> }
	meta?: Record<string, unknown> | null
}

interface TreeNode {
	entry: TreeEntry
	children: TreeNode[]
	isOnActivePath: boolean
}

interface TreeData {
	tree: TreeNode[]
	leafId: string | null
	session: number
	entryCount: number
	branchCount: number
}

interface TreeViewProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	getTree: () => Promise<unknown>
	onBranchSwitch: (entryId: string) => Promise<void>
}

function getEntryPreview(entry: TreeEntry): string {
	const text = entry.payload.parts
		.filter(p => p.type === 'text' && p.text)
		.map(p => p.text!)
		.join(' ')
	if (!text) return `[${entry.type}]`
	return text.length > 80
		? text.slice(0, 77) + '\u2026'
		: text
}

function getEntryRole(
	entry: TreeEntry
): 'user' | 'agent' | 'system' {
	const sender = entry.meta?.sender as string | undefined
	if (sender === 'agent') return 'agent'
	if (sender === 'system') return 'system'
	return 'user'
}

const INDENT = 14
const RAIL_OFFSET = 13

function TreeNodeComponent({
	node,
	leafId,
	selectedId,
	depth,
	onSelect,
	isLastChild,
	parentIsActive
}: {
	node: TreeNode
	leafId: string | null
	selectedId: string | null
	depth: number
	onSelect: (entryId: string) => void
	isLastChild: boolean
	parentIsActive: boolean
}) {
	const [expanded, setExpanded] = useState(true)
	const isLeaf = node.entry.id === leafId
	const isSelected = node.entry.id === selectedId
	const role = getEntryRole(node.entry)
	const hasBranches = node.children.length > 1
	const preview = getEntryPreview(node.entry)
	const isActive = node.isOnActivePath
	const railColor =
		parentIsActive && isActive
			? 'bg-primary/40'
			: 'bg-border'

	return (
		<div className="relative">
			{/* Vertical rail from parent */}
			{depth > 0 && (
				<div
					className={cn(
						'absolute top-0 w-px',
						isLastChild ? 'h-[18px]' : 'h-full',
						railColor
					)}
					style={{
						left: `${(depth - 1) * INDENT + RAIL_OFFSET}px`
					}}
				/>
			)}

			{/* Horizontal connector */}
			{depth > 0 && (
				<div
					className={cn(
						'absolute top-[18px] h-px w-3',
						railColor
					)}
					style={{
						left: `${(depth - 1) * INDENT + RAIL_OFFSET}px`
					}}
				/>
			)}

			{/* Node row */}
			<div
				role="button"
				tabIndex={0}
				onClick={() => onSelect(node.entry.id)}
				onKeyDown={e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						onSelect(node.entry.id)
					}
				}}
				className={cn(
					'group relative flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-all duration-150 cursor-pointer',
					'hover:bg-accent/60',
					isSelected &&
						'bg-primary/10 ring-1 ring-primary/30',
					isLeaf && !isSelected && 'bg-primary/6'
				)}
				style={{ marginLeft: `${depth * INDENT + 8}px` }}
			>
				{/* Expand toggle or leaf dot */}
				<div className="relative mt-[3px] shrink-0">
					{node.children.length > 0 ? (
						<button
							type="button"
							onClick={e => {
								e.stopPropagation()
								setExpanded(!expanded)
							}}
							className={cn(
								'flex size-5 items-center justify-center rounded-full transition-colors',
								isActive
									? 'bg-primary/15 text-primary hover:bg-primary/25'
									: 'bg-muted text-muted-foreground hover:bg-accent'
							)}
						>
							<ChevronRightIcon
								className={cn(
									'size-3 transition-transform duration-200',
									expanded && 'rotate-90'
								)}
							/>
						</button>
					) : (
						<div className="flex size-5 items-center justify-center">
							<div
								className={cn(
									'size-[7px] rounded-full transition-colors',
									isLeaf
										? 'bg-primary ring-2 ring-primary/25'
										: isActive
											? 'bg-primary/50'
											: 'bg-muted-foreground/30'
								)}
							/>
						</div>
					)}
				</div>

				{/* Role badge */}
				<div
					className={cn(
						'mt-[3px] flex size-5 shrink-0 items-center justify-center rounded-md',
						role === 'agent'
							? 'bg-primary/10 text-primary'
							: 'bg-muted text-muted-foreground'
					)}
				>
					{role === 'agent' ? (
						<BotIcon className="size-3" />
					) : (
						<MessageSquareIcon className="size-3" />
					)}
				</div>

				{/* Content */}
				<div className="min-w-0 flex-1">
					<p
						className={cn(
							'truncate leading-snug',
							isActive
								? 'text-foreground'
								: 'text-muted-foreground',
							isSelected && 'text-foreground font-medium'
						)}
					>
						{preview}
					</p>
					<div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
						<span className="font-mono tabular-nums">
							{new Date(node.entry.ts).toLocaleTimeString(
								[],
								{
									hour: '2-digit',
									minute: '2-digit'
								}
							)}
						</span>
						{hasBranches && (
							<span className="flex items-center gap-1 text-primary/70">
								<GitForkIcon className="size-2.5" />
								<span className="font-medium">
									{node.children.length}
								</span>
							</span>
						)}
						{isLeaf && (
							<span className="rounded-full bg-primary/15 px-1.5 py-px font-medium text-primary text-[9px] uppercase tracking-wider">
								current
							</span>
						)}
					</div>
				</div>
			</div>

			{/* Children */}
			{expanded && node.children.length > 0 && (
				<div className="relative">
					{node.children.map((child, i) => (
						<TreeNodeComponent
							key={child.entry.id}
							node={child}
							leafId={leafId}
							selectedId={selectedId}
							depth={depth + 1}
							onSelect={onSelect}
							isLastChild={i === node.children.length - 1}
							parentIsActive={isActive}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export function TreeView({
	open,
	onOpenChange,
	getTree,
	onBranchSwitch
}: TreeViewProps) {
	const [treeData, setTreeData] = useState<TreeData | null>(
		null
	)
	const [selectedId, setSelectedId] = useState<
		string | null
	>(null)
	const [loading, setLoading] = useState(false)
	const [switching, setSwitching] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) {
			setSelectedId(null)
			setError(null)
			return
		}
		setLoading(true)
		setError(null)
		;(async () => {
			try {
				const data = await getTree()
				setTreeData(data as TreeData)
			} catch (err) {
				setError(String(err))
			} finally {
				setLoading(false)
			}
		})()
	}, [open, getTree])

	const handleSwitch = async () => {
		if (!selectedId) return
		setSwitching(true)
		try {
			await onBranchSwitch(selectedId)
			onOpenChange(false)
		} catch (err) {
			setError(String(err))
		} finally {
			setSwitching(false)
		}
	}

	const isCurrentLeaf = selectedId === treeData?.leafId
	const scrollRef = useRef<HTMLDivElement>(null)

	const handleScroll = useCallback(() => {
		const el = scrollRef.current
		if (!el) return
		const { scrollTop, scrollHeight, clientHeight } = el
		const scrollRatio =
			scrollHeight > clientHeight
				? scrollTop / (scrollHeight - clientHeight)
				: 0
		const maxShift = Math.max(
			0,
			el.scrollWidth - el.clientWidth
		)
		el.scrollLeft = Math.round(scrollRatio * maxShift)
	}, [])

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-2xl max-h-[80vh] !grid-rows-[auto_1fr_auto]">
				<CredenzaHeader>
					<CredenzaTitle className="flex items-center gap-2">
						<div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
							<GitBranchIcon className="size-3.5 text-primary" />
						</div>
						<span className="font-display text-base">
							Conversation Tree
						</span>
					</CredenzaTitle>
					<CredenzaDescription asChild>
						<div>
							{treeData && (
								<div className="flex items-center gap-3 text-xs">
									<span className="flex items-center gap-1.5">
										<span className="font-mono tabular-nums font-medium text-foreground">
											{treeData.entryCount}
										</span>
										entries
									</span>
									<span className="text-border">|</span>
									<span className="flex items-center gap-1.5">
										<span className="font-mono tabular-nums font-medium text-foreground">
											{treeData.branchCount}
										</span>
										branches
									</span>
									<span className="ml-auto text-muted-foreground/50">
										click to select, then switch
									</span>
								</div>
							)}
						</div>
					</CredenzaDescription>
				</CredenzaHeader>

				<CredenzaBody>
					<div
						ref={scrollRef}
						onScroll={handleScroll}
						className="overflow-auto min-h-0 -mx-2 px-2 max-h-[60vh]"
					>
						{loading && (
							<div className="flex flex-col items-center justify-center gap-3 py-12">
								<div className="flex gap-1">
									<span className="size-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:0ms]" />
									<span className="size-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:150ms]" />
									<span className="size-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:300ms]" />
								</div>
								<p className="text-xs text-muted-foreground">
									Loading tree
								</p>
							</div>
						)}
						{error && (
							<div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center">
								<p className="text-sm text-destructive">
									{error}
								</p>
							</div>
						)}
						{treeData && !loading && (
							<div className="py-1">
								{treeData.tree.length === 0 ? (
									<div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
										<MessageSquareIcon className="size-8 opacity-20" />
										<p className="text-sm">
											No entries in this session
										</p>
									</div>
								) : (
									treeData.tree.map((node, i) => (
										<TreeNodeComponent
											key={node.entry.id}
											node={node}
											leafId={treeData.leafId}
											selectedId={selectedId}
											depth={0}
											onSelect={setSelectedId}
											isLastChild={
												i === treeData.tree.length - 1
											}
											parentIsActive={false}
										/>
									))
								)}
							</div>
						)}
					</div>
				</CredenzaBody>

				{selectedId && !isCurrentLeaf && (
					<CredenzaFooter className="border-t pt-3">
						<Button
							size="sm"
							onClick={handleSwitch}
							disabled={switching}
							className="gap-2"
						>
							<ArrowRightIcon className="size-3.5" />
							{switching
								? 'Switching\u2026'
								: 'Switch to this branch'}
						</Button>
					</CredenzaFooter>
				)}
			</CredenzaContent>
		</Credenza>
	)
}
