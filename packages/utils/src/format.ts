const UNITS = [
	'B',
	'KB',
	'MB',
	'GB',
	'TB',
	'PB',
	'EB',
	'ZB',
	'YB'
] as const

export function formatBytes(
	bytes: number | null | undefined,
	decimals = 1
): string {
	if (bytes == null || !+bytes) return '0 B'
	const k = 1024
	const dm = Math.max(0, decimals)
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	const unit = UNITS[i] ?? UNITS[UNITS.length - 1]
	return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${unit}`
}
