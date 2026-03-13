import { NumberTicker } from '@/components/ui/number-ticker'

export function Cost({ value }: { value: number }) {
	const decimalPlaces = value >= 0.01 ? 2 : 4
	return (
		<span>
			$
			<NumberTicker
				value={value}
				decimalPlaces={decimalPlaces}
				className="text-inherit tracking-inherit"
			/>
		</span>
	)
}
