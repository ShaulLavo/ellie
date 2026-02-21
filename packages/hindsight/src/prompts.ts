// ── Fact Extraction (Python parity) ────────────────────────────────────────

export const EXTRACTION_CANONICAL_TIMEZONE = "Asia/Jerusalem"

const FACT_TYPES_INSTRUCTION =
  `Extract ONLY "world" and "assistant" type facts.`

const EXTRACTION_RESPONSE_FORMAT = `RESPONSE FORMAT: Return ONLY valid JSON:
{
  "facts": [
    {
      "what": "Core fact (1-2 concise sentences)",
      "when": "Temporal description or N/A",
      "where": "Location or N/A",
      "who": "People/entities involved or N/A",
      "why": "Context/significance or N/A",
      "fact_kind": "event" | "conversation",
      "fact_type": "world" | "assistant",
      "occurred_start": "ISO datetime or null",
      "occurred_end": "ISO datetime or null",
      "entities": [{ "text": "Entity name" }],
      "causal_relations": [{ "target_index": 0, "relation_type": "caused_by", "strength": 1.0 }]
    }
  ]
}`

const BASE_FACT_EXTRACTION_PROMPT = `Extract SIGNIFICANT facts from text. Be SELECTIVE — only extract facts worth remembering long-term.

LANGUAGE REQUIREMENT: Detect the language of the input text. All extracted facts, entity names, descriptions, and output MUST be in the SAME language as the input. Do not translate.

${FACT_TYPES_INSTRUCTION}

{extraction_guidelines}

FACT FORMAT — BE CONCISE (all fields required):
1. what: Core fact — concise but complete (1-2 sentences max)
2. when: Temporal info if mentioned, otherwise "N/A"
3. where: Location if relevant, otherwise "N/A"
4. who: People involved with relationships, otherwise "N/A"
5. why: Context/significance if important, otherwise "N/A"

CONCISENESS: Capture the essence, not every word. One good sentence beats three mediocre ones.

COREFERENCE RESOLUTION:
- Resolve generic references to names when both appear.
- "my roommate" + "Emily" -> use "Emily (user's roommate)"

CLASSIFICATION:
- fact_kind="event": specific datable occurrence
- fact_kind="conversation": ongoing state, preference, trait
- fact_type="world": user life, other people, external events
- fact_type="assistant": interaction with assistant (requests/help)

TEMPORAL HANDLING (CRITICAL):
- Use "Event Date" from input as the reference for relative dates.
- For events: set occurred_start and occurred_end.
- For conversations: do not set occurred dates.
- If text has an absolute date (e.g. "March 15, 2024"), preserve it in occurred_start.

ENTITIES:
- Include people, organizations, places, key objects, and abstract concepts.
- Always include "user" when fact is about the user.

CAUSAL RELATIONSHIPS:
Link facts with causal_relations (max 2 per fact). target_index must be < this fact's index.
Type: "caused_by" (this fact was caused by the target fact)

Example: "Lost job → couldn't pay rent → moved apartment"
- Fact 0: Lost job, causal_relations: null
- Fact 1: Couldn't pay rent, causal_relations: [{target_index: 0, relation_type: "caused_by"}]
- Fact 2: Moved apartment, causal_relations: [{target_index: 1, relation_type: "caused_by"}]

${EXTRACTION_RESPONSE_FORMAT}`

const CONCISE_GUIDELINES = `SELECTIVITY — extract only facts worth remembering long-term.

ONLY extract facts that are:
✅ Personal info: names, relationships, roles, background
✅ Preferences: likes, dislikes, habits, interests (e.g., "Alice likes coffee")
✅ Significant events: milestones, decisions, achievements, changes
✅ Plans/goals: future intentions, deadlines, commitments
✅ Expertise: skills, knowledge, certifications, experience
✅ Important context: projects, problems, constraints
✅ Sensory/emotional details: feelings, sensations, perceptions that provide context
✅ Observations: descriptions of people, places, things with specific details

DO NOT extract:
❌ Generic greetings: "how are you", "hello", pleasantries without substance
❌ Pure filler: "thanks", "sounds good", "ok", "got it", "sure"
❌ Process chatter: "let me check", "one moment", "I'll look into it"
❌ Repeated info: if already stated, don't extract again

CONSOLIDATE related statements into ONE fact when possible.

EXAMPLES:

Example 1 — Selective extraction (Event Date: June 10, 2024):
Input: "Hey! How's it going? Good morning! So I'm planning my wedding - want a small outdoor ceremony. Just got back from Emily's wedding, she married Sarah at a rooftop garden. It was nice weather. I grabbed a coffee on the way."
Output: ONLY 2 facts (skip greetings, weather, coffee):
1. what="User planning wedding, wants small outdoor ceremony", who="user", entities=["user", "wedding"]
2. what="Emily married Sarah at rooftop garden", who="Emily (user's friend), Sarah", occurred_start="2024-06-09", entities=["Emily", "Sarah", "wedding"]

Example 2 — Professional context:
Input: "Alice has 5 years of Kubernetes experience and holds CKA certification. She's been leading the infrastructure team since March. By the way, she prefers dark roast coffee."
Output: ONLY 2 facts (skip coffee preference — too trivial):
1. what="Alice has 5 years Kubernetes experience, CKA certified", who="Alice", entities=["Alice", "Kubernetes", "CKA"]
2. what="Alice leads infrastructure team since March", who="Alice", entities=["Alice", "infrastructure"]

QUALITY OVER QUANTITY: ask "Would this be useful to recall in 6 months?" If no, skip it.

IMPORTANT: Sensory/emotional details and observations that provide meaningful context
about experiences ARE important to remember, even if they seem small (e.g., how food
tasted, how someone looked, how loud music was). Extract these if they characterize
an experience or person.`

const VERBOSE_GUIDELINES = `Extract facts with maximum detail and preserve all specific information.
Still apply temporal handling, coreference resolution, and classification rules exactly.`

export const EXTRACT_FACTS_SYSTEM = BASE_FACT_EXTRACTION_PROMPT.replace(
  "{extraction_guidelines}",
  CONCISE_GUIDELINES,
)

export const EXTRACT_FACTS_VERBOSE_SYSTEM = BASE_FACT_EXTRACTION_PROMPT.replace(
  "{extraction_guidelines}",
  VERBOSE_GUIDELINES,
)

// ── Extraction mode selector ───────────────────────────────────────────────

export function getExtractionPrompt(
  mode: "concise" | "verbose" | "custom",
  customGuidelines?: string,
): string {
  if (mode === "verbose") return EXTRACT_FACTS_VERBOSE_SYSTEM
  if (mode === "custom" && customGuidelines) {
    return BASE_FACT_EXTRACTION_PROMPT.replace(
      "{extraction_guidelines}",
      customGuidelines,
    )
  }
  return EXTRACT_FACTS_SYSTEM
}

// ── User message ───────────────────────────────────────────────────────────

export interface ExtractFactsUserPromptInput {
  text: string
  chunkIndex: number
  totalChunks: number
  eventDateMs: number
  context?: string | null
}

function formatEventDate(eventDateMs: number): string {
  const date = new Date(eventDateMs)
  if (Number.isNaN(date.getTime())) return "Unknown date (invalid)"
  const readable = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
    timeZone: EXTRACTION_CANONICAL_TIMEZONE,
  }).format(date)
  return `${readable} (${date.toISOString()})`
}

export const EXTRACT_FACTS_USER = (input: ExtractFactsUserPromptInput) =>
  `Extract facts from the following text chunk.

Chunk: ${input.chunkIndex + 1}/${input.totalChunks}
Event Date: ${formatEventDate(input.eventDateMs)}
Context: ${input.context?.trim() || "none"}

Text:
${input.text}`

// ── Consolidation ─────────────────────────────────────────────────────────

export const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Your job is to convert raw facts into durable knowledge (observations).

GOAL: Extract DURABLE knowledge — things that will remain true and useful over time.

You will receive:
1. A new fact that was just remembered
2. A list of existing observations that are related (if any)

DECIDE what to do with the new fact:

ACTIONS:
- "create" — The fact contains new durable knowledge not covered by existing observations. Create a new observation.
- "update" — The fact adds to, refines, or changes an existing observation. Update it with the new information.
- "merge" — Multiple existing observations should be combined into one consolidated observation.
- "skip" — The fact is ephemeral, trivial, or already fully captured. No action needed.

RULES:
- Extract DURABLE knowledge: patterns, relationships, preferences, capabilities, recurring themes
- DO NOT create observations for ephemeral state (current mood, what someone is doing right now)
- Preserve specific details: names, locations, numbers, dates
- When updating, include ALL information from both old and new — never lose existing details
- NEVER merge facts about DIFFERENT people or unrelated topics
- When merging contradictions, capture BOTH states with temporal markers ("Previously X, now Y")
- Each observation should be self-contained and make sense on its own
- Use clear, concise language

RESPONSE FORMAT: Return ONLY valid JSON — an array of actions:
[
  {"action": "create", "text": "Durable observation text", "reason": "Why this is worth remembering"},
  {"action": "update", "observationId": "existing-id", "text": "Updated observation text", "reason": "What changed"},
  {"action": "merge", "observationIds": ["obs-1", "obs-2"], "text": "Merged observation text", "reason": "Why these observations should be merged"},
  {"action": "skip", "reason": "No durable knowledge to store"}
]

You may also return [] if no action is needed.`

export interface ConsolidationPromptFact {
  id: string
  content: string
  occurredStart: number | null
  occurredEnd: number | null
  mentionedAt: number | null
  tags: string[]
}

export interface ConsolidationPromptObservation {
  id: string
  content: string
  proofCount: number
  sourceCount: number
  occurredStart: number | null
  occurredEnd: number | null
  mentionedAt: number | null
}

function formatEpochMs(value: number | null): string {
  if (value == null) return "null"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "null" : date.toISOString()
}

export function getConsolidationUserPrompt(
  newFact: ConsolidationPromptFact,
  relatedObservations: ConsolidationPromptObservation[],
): string {
  let prompt = `NEW FACT [ID: ${newFact.id}]:\n${newFact.content}\n`
  prompt += `Temporal:\n`
  prompt += `- occurredStart: ${formatEpochMs(newFact.occurredStart)}\n`
  prompt += `- occurredEnd: ${formatEpochMs(newFact.occurredEnd)}\n`
  prompt += `- mentionedAt: ${formatEpochMs(newFact.mentionedAt)}\n`
  prompt += `- tags: ${newFact.tags.join(", ") || "none"}\n`

  if (relatedObservations.length > 0) {
    prompt += "\nEXISTING RELATED OBSERVATIONS:\n"
    for (const obs of relatedObservations) {
      prompt += `\n[ID: ${obs.id}] (backed by ${obs.proofCount} facts, ${obs.sourceCount} sources)\n`
      prompt += `Temporal: occurredStart=${formatEpochMs(obs.occurredStart)}, occurredEnd=${formatEpochMs(obs.occurredEnd)}, mentionedAt=${formatEpochMs(obs.mentionedAt)}\n`
      prompt += `${obs.content}\n`
    }
  } else {
    prompt += "\nNo existing related observations found.\n"
  }

  prompt +=
    "\nDecide: create, update, merge observations when needed, or skip."
  return prompt
}

// ── Reflect Agent (3-tier) ─────────────────────────────────────────────────

import type { ReflectBudget } from "./types"

const BUDGET_GUIDANCE: Record<ReflectBudget, string> = {
  low: "You have a LOW budget. Be efficient — check mental models first. If one matches and is fresh, answer directly. Only drill down if stale or absent.",
  mid: "You have a MEDIUM budget. Check mental models, then observations. Drill into raw facts if staleness signals suggest it or you need more detail.",
  high: "You have a HIGH budget. Be thorough — search all tiers. Cross-reference observations with raw facts. Use get_entity to explore connections. Build the most complete answer possible.",
}

export function getReflectSystemPrompt(budget: ReflectBudget): string {
  return `You are a reflection agent that answers questions by reasoning over a 3-tier memory hierarchy.

MEMORY HIERARCHY (search in this order):

TIER 1 — Mental Models (search_mental_models)
  User-curated summaries. Highest reliability. Use FIRST.
  If a result has is_stale=true, verify by also searching Tier 2 or 3.

TIER 2 — Observations (search_observations)
  Auto-consolidated durable knowledge synthesized from multiple raw facts.
  Check the "freshness" field:
    - "up_to_date": trustworthy as-is
    - "slightly_stale": probably fine, but search raw facts if answer seems incomplete
    - "stale": MUST verify with search_memories (Tier 3)

TIER 3 — Raw Facts (search_memories)
  Individual experiences and world knowledge. Ground truth.
  Use when models/observations don't exist, are stale, or you need specific details.

UTILITY — get_entity
  Look up any named entity and its associated memories. Works across all tiers.

UTILITY — expand
  Expand one or more memory IDs to chunk or full-document context.
  Use this when a retrieved fact is relevant but lacks enough surrounding detail.

RETRIEVAL STRATEGY:
${BUDGET_GUIDANCE[budget]}

CRITICAL RULES:
- ONLY use information from tool results — no external knowledge or guessing
- You SHOULD synthesize, infer, and reason from retrieved memories
- You MUST search before saying you don't have information
- NEVER make up names, people, events, or entities
- Staleness signals (is_stale, freshness) tell you whether to drill deeper — use them

QUERY STRATEGY:
All search tools use semantic search. NEVER just echo the user's question. Decompose it:
  BAD:  search_observations("recurring themes in meetings")
  GOOD: search_mental_models("meeting patterns") first, then
        search_observations("meetings") + search_observations("discussion topics")
Think: What ENTITIES and CONCEPTS does this question involve? Search for each separately.
If supporting evidence seems too terse, call expand(memoryIds, depth) before finalizing.

HOW TO REASON:
- Synthesize a coherent narrative from retrieved memories across tiers
- If memories mention someone did an activity, you can infer they likely enjoyed it
- When the exact answer isn't stated, use what IS stated to give the best answer
- Be a thoughtful interpreter, not just a literal repeater

FORMATTING:
- Give clear, well-structured answers
- Cite specific facts when possible
- Only say "I don't have information" if the retrieved data is truly unrelated to the question`
}

// ── Directive Injection ──────────────────────────────────────────────────

import type { Directive } from "./types"

/**
 * Build the directives section for the TOP of the reflect system prompt.
 * Returns empty string when no directives are provided.
 */
export function buildDirectivesSection(directives: Directive[]): string {
  if (directives.length === 0) return ""

  const items = directives
    .map((d) => `- **${d.name}**: ${d.content}`)
    .join("\n")

  return `## DIRECTIVES (MANDATORY)
These are hard rules you MUST follow in ALL responses:

${items}

NEVER violate these directives, even if other context suggests otherwise.
Do NOT explain or justify how you handled directives in your answer. Just follow them silently.

`
}

/**
 * Build the directives reminder for the BOTTOM of the reflect system prompt.
 * Leverages the recency effect — LLMs weight recent context more heavily.
 * Returns empty string when no directives are provided.
 */
export function buildDirectivesReminder(directives: Directive[]): string {
  if (directives.length === 0) return ""

  const items = directives
    .map((d, i) => `${i + 1}. **${d.name}**: ${d.content}`)
    .join("\n")

  return `

## REMINDER: MANDATORY DIRECTIVES
Before responding, ensure your answer complies with ALL directives:
${items}

Your response will be REJECTED if it violates any directive above.`
}
