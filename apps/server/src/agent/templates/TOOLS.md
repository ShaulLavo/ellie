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

### `exec`

Execute TypeScript in a **fresh isolated environment**. No state persists between calls — every invocation is independent.

- Direct tools (`read_workspace_file`, `write_workspace_file`, `shell`, `ripgrep`) are available as async functions
- Use `print()` to send output to the conversation — **this is required**
- Each call spins up a fresh REPL, runs the code, and tears down
- You can `import` any npm package — Bun auto-installs on first use

```ts
const files = await shell({
	command: 'find . -name "*.ts" -maxdepth 2'
})
const count = files.trim().split('\n').length
print(`Found ${count} TypeScript files`)
```

**When to use:** bounded one-off scripts, quick computations, file transformations, anything that doesn't need state from a previous call.

### `session_exec`

Execute TypeScript in a **persistent REPL session**. Variables, imports, and function definitions survive across consecutive calls.

- Direct tools (`read_workspace_file`, `write_workspace_file`, `shell`, `ripgrep`) are available as async functions
- Use `print()` to send output to the conversation — **this is required**
- Raw `console.log()` output is stored as artifacts but does NOT appear in conversation context
- State persists across calls within the same session
- You can `import` any npm package — Bun auto-installs on first use

```ts
// Call 1: load and parse data
const data = await read_workspace_file({
	path: 'data.json'
})
const parsed = JSON.parse(data)
print(`Loaded ${parsed.items.length} items`)

// Call 2: work with persisted state (variables survive!)
const filtered = parsed.items.filter(i => i.active)
print(`${filtered.length} active items found`)

// Call 3: run a shell command and inspect output
const result = await shell({ command: 'ls -la' })
print(result)
```

**When to use:** iterative exploration, building up analysis state, complex multi-step workflows, loops, conditionals, chaining tool calls, file processing pipelines.

**Session lifecycle:** A session starts automatically on the first `session_exec` call and stays alive for the duration of the agent run. Each evaluation has a default timeout of 30 seconds (configurable via `AGENT_SESSION_EXEC_TIMEOUT_MS`) and output is capped at 256 KB (`AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES`). The session terminates when the agent run ends.

### Selection guide

| Task                                 | Use            |
| ------------------------------------ | -------------- |
| Read a single file                   | Direct tool    |
| Run a shell command                  | Direct tool    |
| Search for a pattern                 | Direct tool    |
| One-off script or computation        | `exec`         |
| Transform a file with logic          | `exec`         |
| Process 10 files in a loop           | `session_exec` |
| Chain 3 tool calls with conditionals | `session_exec` |
| Iteratively explore a dataset        | `session_exec` |
| Build up analysis state across steps | `session_exec` |
| Debug something step by step         | `session_exec` |
