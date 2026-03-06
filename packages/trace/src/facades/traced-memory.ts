/**
 * Traced memory facade — wraps a memory orchestrator so recall and
 * retain operations emit trace events.
 *
 * Uses structural typing to avoid importing @ellie/agent or hindsight types.
 */

import { createChildScope } from '../scope'
import type { TraceScope } from '../types'
import type { TraceRecorder } from '../recorder'

// Minimal structural constraint — intentionally loose so concrete types
// satisfy it without index-signature issues.
interface MemoryLike {
	recall(query: string): Promise<unknown>
	evaluateRetain(
		sessionId: string,
		force?: boolean
	): Promise<unknown>
}

export interface TracedMemoryOptions {
	recorder: TraceRecorder
	parentScope: TraceScope
}

/**
 * Wrap a MemoryOrchestrator so recall() and evaluateRetain()
 * emit memory.recall.start/end and memory.retain.start/end events.
 *
 * Returns a Proxy so the original prototype chain, type identity,
 * and any other methods remain intact.
 */
export function wrapMemoryOrchestrator<
	T extends MemoryLike
>(memory: T, opts: TracedMemoryOptions): T {
	return new Proxy(memory, {
		get(target, prop, receiver) {
			if (prop === 'recall') {
				return async (query: string) => {
					const scope = createChildScope(opts.parentScope)
					const startedAt = Date.now()

					opts.recorder.record(
						scope,
						'memory.recall.start',
						'memory',
						{ query }
					)

					try {
						const result = await target.recall(query)
						const elapsedMs = Date.now() - startedAt
						const r = result as Record<
							string,
							unknown
						> | null
						const payload = r?.payload as Record<
							string,
							unknown
						>

						opts.recorder.record(
							scope,
							'memory.recall.end',
							'memory',
							{
								elapsedMs,
								found: result !== null,
								resultCount:
									(
										payload?.parts as
											| Array<Record<string, unknown>>
											| undefined
									)?.[0]?.count ?? 0,
								bankIds: payload?.bankIds,
								contextBlockLength:
									typeof r?.contextBlock === 'string'
										? r.contextBlock.length
										: 0
							}
						)

						return result
					} catch (err) {
						opts.recorder.record(
							scope,
							'memory.recall.end',
							'memory',
							{
								elapsedMs: Date.now() - startedAt,
								error:
									err instanceof Error
										? err.message
										: String(err)
							}
						)
						throw err
					}
				}
			}

			if (prop === 'evaluateRetain') {
				return async (
					sessionId: string,
					force?: boolean
				) => {
					const scope = createChildScope(opts.parentScope)
					const startedAt = Date.now()

					opts.recorder.record(
						scope,
						'memory.retain.start',
						'memory',
						{ sessionId, force }
					)

					try {
						const result = await target.evaluateRetain(
							sessionId,
							force
						)
						const elapsedMs = Date.now() - startedAt
						const r = result as Record<
							string,
							unknown
						> | null

						opts.recorder.record(
							scope,
							'memory.retain.end',
							'memory',
							{
								elapsedMs,
								triggered: result !== null,
								trigger: r?.trigger,
								factsStored:
									(
										r?.parts as
											| Array<Record<string, unknown>>
											| undefined
									)?.[0]?.factsStored ?? 0,
								bankIds: r?.bankIds
							}
						)

						return result
					} catch (err) {
						opts.recorder.record(
							scope,
							'memory.retain.end',
							'memory',
							{
								elapsedMs: Date.now() - startedAt,
								error:
									err instanceof Error
										? err.message
										: String(err)
							}
						)
						throw err
					}
				}
			}

			return Reflect.get(target, prop, receiver)
		}
	})
}
