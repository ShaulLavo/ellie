---
name: never-nester
description: Enforce never-nester coding style by limiting nesting depth to 3 levels max. Use when writing, reviewing, or refactoring any code. Apply extraction (pulling inner blocks into separate functions) and inversion (flipping conditions to early returns) to flatten deeply nested code. Triggers on any code generation, function writing, refactoring, or code review task.
---

# Never Nester

Limit all code to a maximum nesting depth of 3. Every open brace/block adds one depth level. A function body is depth 1, an `if` inside it is depth 2, a loop inside that is depth 3. Never go to depth 4.

## Two Denesting Techniques

### 1. Inversion (Early Return)

Flip conditions and return early instead of nesting the happy path deeper.

**Before (depth 4):**

```ts
function process(user) {
	if (user) {
		// depth 2
		if (user.isActive) {
			// depth 3
			if (user.hasPermission) {
				// depth 4 — too deep
				return doWork(user)
			}
		}
	}
	return null
}
```

**After (depth 2):**

```ts
function process(user) {
	if (!user) return null // guard
	if (!user.isActive) return null // guard
	if (!user.hasPermission) return null // guard
	return doWork(user) // happy path at depth 1
}
```

Pattern: unhappy paths return early at the top, happy path flows down at the shallowest level.

### 2. Extraction (Pull Into Function)

Extract inner blocks into their own named functions.

**Before (depth 4):**

```ts
function processAll(items) {
	for (const item of items) {
		// depth 2
		if (item.isValid) {
			// depth 3
			for (const sub of item.parts) {
				// depth 4 — too deep
				handle(sub)
			}
		}
	}
}
```

**After (depth 2 each):**

```ts
function processAll(items) {
	for (const item of items) {
		processItem(item)
	}
}

function processItem(item) {
	if (!item.isValid) return
	for (const sub of item.parts) {
		handle(sub)
	}
}
```

## Rules

1. **Max depth 3** — count each block-opening construct (`if`, `else`, `for`, `while`, `try`, `switch`, arrow function body, etc.) as +1 depth from the function body
2. **Apply inversion first** — flip conditions to early returns/continues before extracting
3. **Apply extraction second** — if still too deep after inversion, extract inner logic into named functions
4. **Guard clause section** — group all early-return validations at the top of a function, then follow with the core logic
5. **Loop bodies** — use `continue` with inverted conditions instead of wrapping loop bodies in `if`
6. **Each extracted function gets one responsibility** — name it descriptively after what it does
7. **Never use `else` after an early return** — the `else` is implied; flatten it

## Loop Inversion Example

**Before:**

```ts
for (const item of items) {
	if (item.isActive) {
		if (item.value > threshold) {
			results.push(transform(item))
		}
	}
}
```

**After:**

```ts
for (const item of items) {
	if (!item.isActive) continue
	if (item.value <= threshold) continue
	results.push(transform(item))
}
```

## Never Nest Ternaries

Never nest a ternary expression inside another ternary. If you need conditional logic that would result in a nested ternary, extract each ternary into its own named variable first.

**Bad — nested ternary:**

```ts
const label = isAdmin
	? 'Admin'
	: isEditor
		? 'Editor'
		: 'Viewer'
```

**Good — separate variables:**

```ts
const editorOrViewer = isEditor ? 'Editor' : 'Viewer'
const label = isAdmin ? 'Admin' : editorOrViewer
```

This keeps each conditional self-contained and readable. Apply the same principle for JSX — extract conditional expressions into variables above the return.

## When Reviewing Code

Flag any function exceeding depth 3. Suggest specific inversion or extraction refactors. Prioritize readability: guard clauses at top, happy path flowing down, small focused functions. Flag any nested ternary and suggest extracting inner ternaries into named variables.
