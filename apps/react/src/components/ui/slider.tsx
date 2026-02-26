import { Slider as SliderPrimitive } from '@base-ui/react/slider'

import { cn } from '@/lib/utils'

function Slider({
	className,
	defaultValue,
	value,
	min = 0,
	max = 100,
	...props
}: SliderPrimitive.Root.Props) {
	const _values = value ?? defaultValue ?? [min]

	return (
		<SliderPrimitive.Root
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			className={cn(
				'relative flex w-full touch-none items-center select-none data-disabled:opacity-50',
				className
			)}
			{...props}
		>
			<SliderPrimitive.Control data-slot="slider-control">
				<SliderPrimitive.Track
					data-slot="slider-track"
					className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full"
				>
					<SliderPrimitive.Indicator
						data-slot="slider-range"
						className="bg-primary absolute h-full"
					/>
				</SliderPrimitive.Track>
				{Array.isArray(_values) &&
					_values.map((_: number, index: number) => (
						<SliderPrimitive.Thumb
							data-slot="slider-thumb"
							key={index}
							className="border-primary/50 bg-background focus-visible:ring-ring/50 block size-4 rounded-full border shadow-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none"
						/>
					))}
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	)
}

export { Slider }
