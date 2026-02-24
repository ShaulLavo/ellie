import { useEffect, useState } from "react"
import { eden } from "../lib/eden"

const POLL_INTERVAL = 5_000

export function useConnectedClients(): number | null {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const { data, error } = await eden.api.status.get()
        if (error || !data) return
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
