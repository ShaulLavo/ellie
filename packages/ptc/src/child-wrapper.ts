// PTC child wrapper – this file is read as a string and used as the
// IIFE template that wraps agent code. The placeholder {{AGENT_CODE}}
// is replaced at generation time.
//
// DO NOT import this file. It is read via Bun.file() at generation time.

// ── agent code (wrapped) ────────────────────────────────────────
;(async () => {
	try {
		// {{AGENT_CODE}}
	} catch (__err) {
		const msg =
			__err instanceof Error ? __err.message : String(__err)
		console.error(`[ptc] agent error: ${msg}`)
		process.exit(1)
	}
	process.exit(0)
})()
