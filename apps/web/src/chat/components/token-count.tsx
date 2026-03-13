import { NumberTicker } from '@/components/ui/number-ticker'

export function TokenCount({ value }: { value: number }) {
	if (value >= 1000) {
		return (
			<>
				<NumberTicker
					value={Math.round(value / 1000)}
					className="text-inherit tracking-inherit"
				/>
				k
			</>
		)
	}
	return (
		<NumberTicker
			value={value}
			className="text-inherit tracking-inherit"
		/>
	)
}
