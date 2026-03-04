import { Moon, Sun } from 'lucide-react'
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger
} from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/use-theme'

export function DbThemeToggle() {
	const { theme, setPreference } = useTheme()
	const isDark = theme === 'dark'

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() =>
							setPreference(isDark ? 'light' : 'dark')
						}
						className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					/>
				}
			>
				{isDark ? (
					<Sun className="size-3.5" />
				) : (
					<Moon className="size-3.5" />
				)}
			</TooltipTrigger>
			<TooltipContent>Toggle theme</TooltipContent>
		</Tooltip>
	)
}
