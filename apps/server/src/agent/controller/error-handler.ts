/**
 * Shared error-handling helper for agent controller modules.
 * Encapsulates the console.error + trace pattern used across
 * controller.ts, stream-persistence.ts, and memory.ts.
 */

type TraceFn = (
	type: string,
	payload: Record<string, unknown>
) => void

export function handleControllerError(
	trace: TraceFn,
	label: string,
	traceType: string,
	context: Record<string, unknown>,
	err: unknown,
	level: 'error' | 'warn' = 'error'
): void {
	const message =
		err instanceof Error ? err.message : String(err)
	if (level === 'warn') {
		console.warn(`[agent-controller] ${label}`, message)
	} else {
		console.error(`[agent-controller] ${label}`, message)
	}
	trace(traceType, { ...context, message })
}
