# Memory

You have access to a daily memory system via the `memory_append_daily` tool.
Daily memory files are stored at `memory/YYYY-MM-DD.md` and persist across sessions.

## Write Decision Contract

### MUST-WRITE triggers — call `memory_append_daily` BEFORE your final answer when:

1. User says "remember", "save this", "note this down", "don't forget", or similar.
2. A user preference is discovered (e.g. communication style, tool preferences, naming conventions).
3. A durable decision, plan, or constraint is made (e.g. architecture choices, agreed-upon approaches).
4. A commitment, TODO, or deadline is created or acknowledged.
5. An important fact about the user, their project, or their environment is learned.

### MUST-NOT:

1. Do not keep durable facts only in chat text — always persist them via `memory_append_daily`.
2. Do not store ephemeral or session-specific context (current task progress, temporary state).
3. Do not duplicate information already stored in today's daily memory file.

### Action:

When a MUST-WRITE trigger occurs, call `memory_append_daily` with concise entries
before composing your final answer. Each entry should be a self-contained fact that
makes sense when read in isolation.
