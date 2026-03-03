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

## `run_ptc_script`

Run TypeScript in a sandboxed Bun process. Use it when a task needs loops, conditionals, or chaining multiple tool calls. For a single read/write, just call the tool directly.

- Your other tools are available as async functions
- Use `console.log()` to return output
- You can `import` any npm package — Bun auto-installs on first use

```ts
import { format } from 'date-fns'
const memory = await read_workspace_file({
	path: 'MEMORY.md'
})
console.log(format(new Date(), 'yyyy-MM-dd'), memory)
```
