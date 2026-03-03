# Tools

_Your human's tool stack. When they mention a service, subscription, or platform — log it here._

For each tool, capture what matters: name, tier, cost, limits, renewal dates, what it integrates with. When they ask for help, check here first — recommend from what they already have before suggesting new things.

<!-- Example entry:
### Vercel
- **Tier:** Hobby (free)
- **Use:** Frontend deployment
- **Integrates with:** GitHub
- **Notes:** Auto-deploys from main branch
-->

No tools documented yet.

---

## Exec Modes

You have three tiers of execution capability. Choose the right one for the task:

### Direct tools

For simple, single-step operations — use them directly:

- `read_workspace_file` / `write_workspace_file` — read/write workspace files
- `shell` — run shell commands
- `ripgrep` — search file contents

### `script_exec`

Run TypeScript in a **sandboxed Bun process**. Ephemeral — no state persists between calls. Use it when a task needs loops, conditionals, or chaining multiple tool calls in a single bounded script.

- Direct tools (`read_workspace_file`, `write_workspace_file`, `shell`, `ripgrep`) are available as async functions
- Use `console.log()` to return output
- You can `import` any npm package — Bun auto-installs on first use

```ts
import { format } from 'date-fns'
const memory = await read_workspace_file({
	path: 'MEMORY.md'
})
console.log(format(new Date(), 'yyyy-MM-dd'), memory)
```

**When to use:** bounded multi-step scripts, data transformations, file processing pipelines.

### `session_exec`

Execute TypeScript in a **persistent REPL session**. Variables, imports, and function definitions survive across consecutive calls.

- Use `print()` to send output to the conversation
- Raw `console.log()` output is stored as artifacts but does NOT appear in conversation context
- State persists across calls within the same session

```ts
// Call 1: set up data
const data = await read_workspace_file({
	path: 'data.json'
})
const parsed = JSON.parse(data)
print(`Loaded ${parsed.items.length} items`)

// Call 2: work with persisted state
const filtered = parsed.items.filter(i => i.active)
print(`${filtered.length} active items found`)
```

**When to use:** iterative exploration, building up analysis state, complex multi-step workflows where you need to inspect intermediate results.

**Session lifecycle:** A session starts automatically on the first `session_exec` call and stays alive for the duration of the agent run. Each evaluation has a default timeout of 30 seconds (configurable via `AGENT_SESSION_EXEC_TIMEOUT_MS`) and output is capped at 256 KB (`AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES`). The session terminates when the agent run ends.

### Selection guide

| Task                                 | Use            |
| ------------------------------------ | -------------- |
| Read a single file                   | Direct tool    |
| Run a shell command                  | Direct tool    |
| Search for a pattern                 | Direct tool    |
| Process 10 files in a loop           | `script_exec`  |
| Chain 3 tool calls with conditionals | `script_exec`  |
| Iteratively explore a dataset        | `session_exec` |
| Build up analysis state across steps | `session_exec` |
| Debug something step by step         | `session_exec` |
