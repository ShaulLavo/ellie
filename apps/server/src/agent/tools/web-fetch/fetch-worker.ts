/**
 * Fetch worker — lazy singleton managing headless Chrome via a Web Worker.
 * Handles lifecycle, timeouts, and process cleanup.
 */

import * as Comlink from 'comlink'
import type { FetchWorkerApi } from './defuddle.worker'

const WORKER_TIMEOUT = 5 * 60_000

let _worker: Worker | null = null
let _proxy: Comlink.Remote<FetchWorkerApi> | null = null

function destroyWorker() {
	const proxy = _proxy
	const worker = _worker
	_proxy = null
	_worker = null

	if (proxy) {
		try {
			proxy[Comlink.releaseProxy]()
		} catch {
			// Worker already dead — ignore
		}
	}
	if (worker) {
		worker.terminate()
	}
}

function getFetchWorker(): {
	proxy: Comlink.Remote<FetchWorkerApi>
	worker: Worker
} {
	if (!_proxy || !_worker) {
		destroyWorker()
		const w = new Worker(
			new URL('./defuddle.worker.ts', import.meta.url)
		)
		w.addEventListener('error', destroyWorker)
		_worker = w
		_proxy = Comlink.wrap<FetchWorkerApi>(w)
	}
	return { proxy: _proxy, worker: _worker }
}

/** Call a worker method with a timeout and worker-death detection. */
export async function callWorker<T>(
	fn: (proxy: Comlink.Remote<FetchWorkerApi>) => Promise<T>
): Promise<T> {
	const { proxy, worker } = getFetchWorker()

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			destroyWorker()
			reject(new Error('Worker timed out'))
		}, WORKER_TIMEOUT)

		const onError = () => {
			clearTimeout(timer)
			reject(new Error('Worker terminated unexpectedly'))
		}
		worker.addEventListener('error', onError, {
			once: true
		})

		fn(proxy)
			.then(resolve)
			.catch(reject)
			.finally(() => {
				clearTimeout(timer)
				worker.removeEventListener('error', onError)
			})
	})
}

// ── Process lifecycle cleanup ────────────────────────────────────────

// Close browser in worker on exit — covers clean shutdowns
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (_proxy) {
			const close = _proxy.close()
			const timeout = setTimeout(
				() => process.exit(0),
				3_000
			)
			close.finally(() => {
				clearTimeout(timeout)
				process.exit(0)
			})
		} else {
			process.exit(0)
		}
	})
}

// Best-effort cleanup on crashes — the PID file will handle
// true orphans on next startup, but try to clean up here too.
process.on('beforeExit', () => {
	destroyWorker()
})

for (const event of [
	'uncaughtException',
	'unhandledRejection'
] as const) {
	process.on(event, () => {
		destroyWorker()
	})
}
