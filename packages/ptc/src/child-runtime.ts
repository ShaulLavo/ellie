// PTC child SDK runtime – this file is read as a string and injected
// into generated child scripts. It must be self-contained.
//
// DO NOT import this file. It is read via Bun.file() at generation time.

const __pending = new Map<
	string,
	{
		resolve: (v: unknown) => void
		reject: (e: Error) => void
	}
>()
let __callCounter = 0

interface __PtcResult {
	__ptc_result__: true
	id: string
	result?: unknown
	error?: unknown
}

function __isPtcResult(msg: unknown): msg is __PtcResult {
	if (typeof msg !== 'object' || msg === null) return false
	const obj = msg as Record<string, unknown>
	return (
		obj.__ptc_result__ === true &&
		typeof obj.id === 'string'
	)
}

// IPC message handler – resolves pending tool-result promises.
process.on('message', (msg: unknown) => {
	if (!__isPtcResult(msg)) return
	const p = __pending.get(msg.id)
	if (p) {
		__pending.delete(msg.id)
		if (msg.error !== undefined) {
			p.reject(new Error(String(msg.error)))
		} else {
			p.resolve(msg.result)
		}
	}
})

async function __callTool(
	name: string,
	args?: Record<string, unknown>
): Promise<unknown> {
	const id = String(++__callCounter)
	// Register the pending promise BEFORE sending so the response
	// can never arrive before we're listening for it.
	const promise = new Promise<unknown>(
		(resolve, reject) => {
			__pending.set(id, { resolve, reject })
		}
	)
	process.send!({
		__ptc_call__: true,
		id,
		tool: name,
		args: args ?? {}
	})
	return promise
}
