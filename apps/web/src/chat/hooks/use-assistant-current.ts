import { useEffect, useState } from 'react'
import { env } from '@ellie/env/client'
import { eden } from '@/lib/eden'

interface AssistantCurrent {
	threadId: string
	branchId: string
}

interface AssistantCurrentResult {
	threadId: string | null
	branchId: string | null
	isLoading: boolean
}

/**
 * Fetches the current assistant thread/branch from the server,
 * then subscribes to the assistant-current SSE for live rotation events.
 */
export function useAssistantCurrent(): AssistantCurrentResult {
	const [current, setCurrent] =
		useState<AssistantCurrent | null>(null)
	const [isLoading, setIsLoading] = useState(true)

	useEffect(() => {
		let disposed = false
		let eventSource: EventSource | null = null

		async function bootstrap() {
			try {
				const { data } =
					await eden.api.assistant.current.get()
				if (disposed) return
				if (data) {
					setCurrent({
						threadId: data.threadId,
						branchId: data.branchId
					})
				}
			} catch {
				// Server may not have a default thread yet
			} finally {
				if (!disposed) setIsLoading(false)
			}

			// Subscribe to rotation events
			const baseUrl = env.API_BASE_URL.replace(/\/$/, '')
			const es = new EventSource(
				`${baseUrl}/api/assistant/current/sse`
			)
			eventSource = es

			es.addEventListener('connected', event => {
				try {
					const data = JSON.parse(
						(event as MessageEvent).data
					) as AssistantCurrent
					if (!disposed && data.threadId && data.branchId) {
						setCurrent(data)
					}
				} catch {
					// ignore parse errors
				}
			})

			es.addEventListener('assistant-change', event => {
				try {
					const data = JSON.parse(
						(event as MessageEvent).data
					) as {
						newThreadId: string
						newBranchId: string
					}
					if (!disposed) {
						setCurrent({
							threadId: data.newThreadId,
							branchId: data.newBranchId
						})
					}
				} catch {
					// ignore parse errors
				}
			})
		}

		bootstrap()

		return () => {
			disposed = true
			eventSource?.close()
		}
	}, [])

	return {
		threadId: current?.threadId ?? null,
		branchId: current?.branchId ?? null,
		isLoading
	}
}
