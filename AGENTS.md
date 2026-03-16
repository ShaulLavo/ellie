This is a greenfield project, we never do backward compatibility. There are no users yet. Do not be Afraid to refactor, break, and rebuild everything.
Never commit with " --no-verify" unless the users asks explicitly to do so.
Always use oxfmt for formatting.
Always use tsgo for type checking.
## React Component Rules

- **One component per file.** No exceptions.
- **Components must be "dumb" and small.**
  - No logic inside components. All pure functions go in util files. Everything that touches React (state, effects, subscriptions) goes in a hook.
  - A single `useState` or `useEffect` is fine, but aggressively move logic out.
- **Hooks are small and split into hooks entirely.** Compose hooks from smaller hooks — don't let them grow.
- **Keep JSX minimal.** If a component has a lot of JSX, split it into smaller components.
- **No `useCallback` / `useMemo` unless truly necessary.** We have React Compiler — it handles memoization for us. Remove existing ones when you encounter them.
