// @ts-nocheck
import { useState, useEffect } from 'react'
import {
	BotIcon,
	CheckIcon,
	EyeIcon,
	BrainIcon
} from 'lucide-react'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaDescription,
	CredenzaBody
} from '@/components/ui/credenza'
import { cn } from '@/lib/utils'
import {
	useAgentModels,
	useAgent,
	useUpdateAgent
} from '@/hooks/use-agent-settings'

interface AgentSettingsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	agentId: string | undefined
}

// Group models by family (Haiku / Sonnet / Opus) based on name
function groupModels(
	models: Array<{
		id: string
		name: string
		provider: string
		supportsThinking: boolean
		supportsVision: boolean
		pricing: { input: number; output: number } | null
	}>
) {
	const groups: Record<string, typeof models> = {}
	for (const m of models) {
		// Extract family: "Haiku 4.5" → "Haiku", "Sonnet 4.6" → "Sonnet"
		const family = m.name.split(' ')[0] ?? 'Other'
		if (!groups[family]) groups[family] = []
		groups[family].push(m)
	}
	// Sort families: Opus → Sonnet → Haiku, then by version desc
	const order = ['Opus', 'Sonnet', 'Haiku']
	return Object.entries(groups)
		.toSorted(([a], [b]) => {
			const ai = order.indexOf(a)
			const bi = order.indexOf(b)
			if (ai === -1 && bi === -1) return a.localeCompare(b)
			if (ai === -1) return 1
			if (bi === -1) return -1
			return ai - bi
		})
		.map(([family, models]) => ({
			family,
			models: models.toSorted((a, b) =>
				b.name.localeCompare(a.name)
			)
		}))
}

function tierColor(family: string) {
	if (family === 'Haiku') return 'text-emerald-500'
	if (family === 'Sonnet') return 'text-blue-500'
	if (family === 'Opus') return 'text-violet-500'
	return 'text-muted-foreground'
}

function tierDot(family: string) {
	if (family === 'Haiku') return 'bg-emerald-500'
	if (family === 'Sonnet') return 'bg-blue-500'
	if (family === 'Opus') return 'bg-violet-500'
	return 'bg-muted-foreground'
}

export function AgentSettingsDialog({
	open,
	onOpenChange,
	agentId
}: AgentSettingsDialogProps) {
	const { data: agent } = useAgent(agentId)
	const { data: models = [] } = useAgentModels()
	const updateAgent = useUpdateAgent(agentId)

	const [selectedModel, setSelectedModel] = useState<
		string | undefined
	>(undefined)
	const [saved, setSaved] = useState(false)

	// Sync local state when agent data arrives
	useEffect(() => {
		if (agent?.model) setSelectedModel(agent.model)
	}, [agent?.model])

	const grouped = groupModels(models)
	const currentModel = models.find(
		m => m.id === selectedModel
	)
	const handleSelect = async (modelId: string) => {
		setSelectedModel(modelId)
		if (modelId === agent?.model) return
		try {
			await updateAgent.mutateAsync({ model: modelId })
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} catch {
			// revert on failure
			setSelectedModel(agent?.model)
		}
	}

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
				{/* Header */}
				<CredenzaHeader className="px-5 pt-5 pb-4 border-b border-border/50">
					<div className="flex items-center gap-3">
						<div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<BotIcon className="size-4" />
						</div>
						<div>
							<CredenzaTitle className="text-sm font-semibold tracking-tight">
								{agent?.name ?? 'Agent'}
							</CredenzaTitle>
							<CredenzaDescription className="text-[11px] text-muted-foreground mt-0.5">
								Model settings
							</CredenzaDescription>
						</div>
					</div>
				</CredenzaHeader>

				<CredenzaBody className="px-0">
					{/* Current model summary */}
					{currentModel && (
						<div className="flex items-center gap-2.5 px-5 py-3.5 bg-muted/30 border-b border-border/40">
							<div
								className={cn(
									'size-1.5 rounded-full shrink-0',
									tierDot(
										currentModel.name.split(' ')[0] ?? ''
									)
								)}
							/>
							<span className="text-xs font-medium text-foreground">
								{currentModel.name}
							</span>
							<div className="flex items-center gap-1.5 ml-auto">
								{currentModel.supportsThinking && (
									<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
										<BrainIcon className="size-3" />
										Thinking
									</span>
								)}
								{currentModel.supportsVision && (
									<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
										<EyeIcon className="size-3" />
										Vision
									</span>
								)}
								{currentModel.pricing && (
									<span className="text-[10px] text-muted-foreground">
										${currentModel.pricing.input}/M in
									</span>
								)}
								{saved && (
									<span className="flex items-center gap-1 text-[10px] text-emerald-500 font-medium">
										<CheckIcon className="size-3" />
										Saved
									</span>
								)}
							</div>
						</div>
					)}

					{/* Model list */}
					<div className="max-h-[400px] overflow-y-auto">
						{grouped.map(
							({ family, models: familyModels }) => (
								<div key={family}>
									{/* Family header */}
									<div className="flex items-center gap-2 px-5 py-2.5 sticky top-0 bg-background/95 backdrop-blur-sm z-10">
										<div
											className={cn(
												'size-1.5 rounded-full',
												tierDot(family)
											)}
										/>
										<span
											className={cn(
												'text-[10px] font-semibold uppercase tracking-widest',
												tierColor(family)
											)}
										>
											{family}
										</span>
										<div className="flex-1 h-px bg-border/40 ml-1" />
									</div>

									{/* Models in family */}
									<div className="px-2 pb-1">
										{familyModels.map(model => {
											const isSelected =
												selectedModel === model.id
											const isPending =
												updateAgent.isPending &&
												selectedModel === model.id

											return (
												<button
													key={model.id}
													onClick={() =>
														handleSelect(model.id)
													}
													disabled={updateAgent.isPending}
													className={cn(
														'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-all duration-100',
														'hover:bg-muted/60 active:bg-muted',
														isSelected &&
															'bg-primary/8 hover:bg-primary/10',
														'disabled:opacity-60 disabled:cursor-not-allowed'
													)}
												>
													{/* Selection indicator */}
													<div
														className={cn(
															'size-4 rounded-full border flex items-center justify-center shrink-0 transition-all',
															isSelected
																? 'border-primary bg-primary'
																: 'border-border/60 bg-transparent'
														)}
													>
														{isSelected && (
															<CheckIcon className="size-2.5 text-primary-foreground" />
														)}
													</div>

													{/* Model name + version */}
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<span
																className={cn(
																	'text-[13px] font-medium',
																	isSelected
																		? 'text-foreground'
																		: 'text-foreground/80'
																)}
															>
																{model.name}
															</span>
															{isPending && (
																<div className="size-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
															)}
														</div>
														<div className="flex items-center gap-2 mt-0.5">
															<span className="text-[10px] text-muted-foreground font-mono">
																{model.id}
															</span>
														</div>
													</div>

													{/* Capabilities */}
													<div className="flex items-center gap-1.5 shrink-0">
														{model.supportsThinking && (
															<span title="Supports extended thinking">
																<BrainIcon className="size-3 text-muted-foreground/60" />
															</span>
														)}
														{model.supportsVision && (
															<span title="Supports vision">
																<EyeIcon className="size-3 text-muted-foreground/60" />
															</span>
														)}
														{model.pricing && (
															<span className="text-[10px] text-muted-foreground/60 tabular-nums">
																${model.pricing.input}
															</span>
														)}
													</div>
												</button>
											)
										})}
									</div>
								</div>
							)
						)}

						{models.length === 0 && (
							<div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
								Loading models…
							</div>
						)}
					</div>
				</CredenzaBody>
			</CredenzaContent>
		</Credenza>
	)
}
