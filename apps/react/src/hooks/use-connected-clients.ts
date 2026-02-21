import { useEffect, useState } from "react"
import { env } from "@ellie/env/client"

const POLL_INTERVAL = 5_000

export function useConnectedClients(): number | null {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(`${env.API_BASE_URL}/api/status`)
        if (!res.ok) return
        const data = (await res.json()) as { connectedClients: number }
        if (!cancelled) setCount(data.connectedClients)
      } catch {
        // ignore — server may be restarting
      }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return count
}
