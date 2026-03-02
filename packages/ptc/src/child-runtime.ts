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

// Background stdin reader – resolves pending tool-result promises.
const __reader = Bun.stdin.stream().getReader()
;(async () => {
	const decoder = new TextDecoder()
	let buffer = ''
	try {
		while (true) {
			const { done, value } = await __reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			let nl: number
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl).trim()
				buffer = buffer.slice(nl + 1)
				if (!line) continue
				try {
					const msg = JSON.parse(line)
					if (msg.__ptc_result__ && msg.id) {
						const p = __pending.get(msg.id)
						if (p) {
							__pending.delete(msg.id)
							if (msg.error !== undefined) {
								p.reject(new Error(String(msg.error)))
							} else {
								p.resolve(msg.result)
							}
						}
					}
				} catch {
					/* ignore malformed host lines */
				}
			}
		}
	} catch {
		/* stdin closed */
	}
})()

async function __callTool(
	name: string,
	args: Record<string, unknown>
): Promise<unknown> {
	const id = String(++__callCounter)
	const msg = JSON.stringify({
		__ptc_call__: true,
		id,
		tool: name,
		args
	})
	await Bun.write(Bun.stdout, msg + '\n')
	return new Promise<unknown>((resolve, reject) => {
		__pending.set(id, { resolve, reject })
	})
}
