// ── Fact Extraction (Concise — default) ────────────────────────────────────

export const EXTRACT_FACTS_SYSTEM = `You extract structured facts from text. Be SELECTIVE — only extract facts worth remembering long-term.

LANGUAGE: Detect the language of the input. All extracted facts, entity names, and descriptions MUST be in the SAME language as the input.

ONLY extract facts that are:
- Personal info: names, relationships, roles, background
- Preferences: likes, dislikes, habits, interests
- Significant events: milestones, decisions, achievements, changes
- Plans/goals: future intentions, deadlines, commitments
- Expertise: skills, knowledge, certifications, experience
- Important context: projects, problems, constraints
- Observations: descriptions of people, places, things with specific details

DO NOT extract:
- Generic greetings, filler, or process chatter
- Information that is trivially obvious from context
- Repeated information

COREFERENCE RESOLUTION:
Replace pronouns with actual names/entities when possible. "She went to the store" → "Alice went to the store" (if Alice was previously mentioned).

CLASSIFICATION:
- "world": External knowledge and general facts
- "experience": Personal experiences, interactions, events that happened
- "opinion": Beliefs, preferences, judgments (include confidence 0.0-1.0)
- "observation": Descriptions of people, places, or things observed

CAUSAL RELATIONS:
If a fact has a directional relationship with another fact you are extracting, note it.
"causalRelations" links this fact to a previously listed fact (by 0-based index).
Use "relationType" to specify the direction:
  - "causes": this fact causes the target fact
  - "caused_by": this fact is caused by the target fact
  - "enables": this fact enables or makes the target fact possible
  - "prevents": this fact prevents or blocks the target fact

RESPONSE FORMAT: Return ONLY valid JSON matching this structure:
{
  "facts": [
    {
      "content": "Clear, self-contained fact statement",
      "factType": "world" | "experience" | "opinion" | "observation",
      "confidence": 1.0,
      "validFrom": "ISO date or null",
      "validTo": "ISO date or null",
      "entities": [
        { "name": "Entity Name", "entityType": "person" | "organization" | "place" | "concept" | "other" }
      ],
      "tags": ["optional", "topic", "tags"],
      "causalRelations": [
        { "targetIndex": 0, "relationType": "causes", "strength": 0.8 }
      ]
    }
  ]
}

For opinions, set confidence between 0.0 and 1.0 based on how strongly the opinion is held.
For temporal facts, set validFrom/validTo as ISO date strings. Use null for unknown or open-ended.
causalRelations is optional — only include when there is a clear directional relationship.
Return an empty facts array if there is nothing worth extracting.`

// ── Fact Extraction (Verbose — capture everything) ─────────────────────────

export const EXTRACT_FACTS_VERBOSE_SYSTEM = `You extract ALL facts from text. Capture EVERY detail — nothing is too small.

LANGUAGE: Detect the language of the input. All extracted facts, entity names, and descriptions MUST be in the SAME language as the input.

Extract EVERYTHING including:
- All names, dates, numbers, quantities mentioned
- All relationships between people, organizations, concepts
- Every event, action, decision, or change described
- All opinions, preferences, likes, dislikes — even casual ones
- Context, setting, atmosphere, emotions
- Technical details, specifications, versions
- Implicit facts and reasonable inferences from the text

COREFERENCE RESOLUTION:
Replace ALL pronouns with actual names/entities when possible. Be thorough.

CLASSIFICATION:
- "world": External knowledge and general facts
- "experience": Personal experiences, interactions, events that happened
- "opinion": Beliefs, preferences, judgments (include confidence 0.0-1.0)
- "observation": Descriptions of people, places, or things observed

CAUSAL RELATIONS:
If a fact has a directional relationship with another fact you are extracting, note it.
"causalRelations" links this fact to a previously listed fact (by 0-based index).
Use "relationType" to specify the direction:
  - "causes": this fact causes the target fact
  - "caused_by": this fact is caused by the target fact
  - "enables": this fact enables or makes the target fact possible
  - "prevents": this fact prevents or blocks the target fact

RESPONSE FORMAT: Return ONLY valid JSON matching this structure:
{
  "facts": [
    {
      "content": "Clear, self-contained fact statement",
      "factType": "world" | "experience" | "opinion" | "observation",
      "confidence": 1.0,
      "validFrom": "ISO date or null",
      "validTo": "ISO date or null",
      "entities": [
        { "name": "Entity Name", "entityType": "person" | "organization" | "place" | "concept" | "other" }
      ],
      "tags": ["optional", "topic", "tags"],
      "causalRelations": [
        { "targetIndex": 0, "relationType": "causes", "strength": 0.8 }
      ]
    }
  ]
}

For opinions, set confidence between 0.0 and 1.0 based on how strongly the opinion is held.
For temporal facts, set validFrom/validTo as ISO date strings. Use null for unknown or open-ended.
causalRelations is optional — only include when there is a clear directional relationship.
NEVER return an empty facts array — there is ALWAYS something worth extracting.`

// ── Extraction mode selector ───────────────────────────────────────────────

export function getExtractionPrompt(
  mode: "concise" | "verbose" | "custom",
  customGuidelines?: string,
): string {
  if (mode === "verbose") return EXTRACT_FACTS_VERBOSE_SYSTEM
  if (mode === "custom" && customGuidelines) {
    return EXTRACT_FACTS_SYSTEM + "\n\nADDITIONAL GUIDELINES:\n" + customGuidelines
  }
  return EXTRACT_FACTS_SYSTEM
}

// ── User message ───────────────────────────────────────────────────────────

export const EXTRACT_FACTS_USER = (content: string) =>
  `Extract the significant facts from the following text:\n\n---\n\n${content}`

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
- Return empty array [] — The fact is ephemeral, trivial, or already fully captured. No action needed.

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
  {"action": "update", "observationId": "existing-id", "text": "Updated observation text", "reason": "What changed"}
]

Or return [] if no action is needed.`

export function getConsolidationUserPrompt(
  newFact: string,
  relatedObservations: Array<{ id: string; content: string; proofCount: number; sourceCount: number }>,
): string {
  let prompt = `NEW FACT:\n${newFact}\n`

  if (relatedObservations.length > 0) {
    prompt += "\nEXISTING RELATED OBSERVATIONS:\n"
    for (const obs of relatedObservations) {
      prompt += `\n[ID: ${obs.id}] (backed by ${obs.proofCount} facts, ${obs.sourceCount} sources)\n${obs.content}\n`
    }
  } else {
    prompt += "\nNo existing related observations found.\n"
  }

  prompt += "\nDecide: create new observation, update existing, or skip (return [])."
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
