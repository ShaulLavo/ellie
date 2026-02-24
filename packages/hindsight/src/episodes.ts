/**
 * Episode management for temporal memory organization.
 */

import { ulid } from "@ellie/utils"
import { eq, sql, and, desc, lt, or, isNull } from "drizzle-orm"
import type { HindsightDatabase } from "./db"
import {
  NARRATIVE_STEPS_DEFAULT,
  NARRATIVE_STEPS_MAX,
  type RetainRoute,
  type EpisodeBoundaryReason,
  type EpisodeSummary,
  type ListEpisodesOptions,
  type ListEpisodesResult,
  type NarrativeInput,
  type NarrativeEvent,
  type NarrativeResult,
} from "./types"
import type { EpisodeRow } from "./schema"

const EPISODE_GAP_MS = 45 * 60 * 1000

const BOUNDARY_PHRASES: RegExp[] = [
  /\bnew task\b/i,
  /\bswitching to\b/i,
  /\bdone with\b/i,
]

interface CursorPayload {
  t: number
  id: string
}

function toSnippet(content: string): string {
  return content.length > 200 ? `${content.slice(0, 200)}…` : content
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8")
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>
    if (typeof parsed.t !== "number" || typeof parsed.id !== "string") return null
    return { t: parsed.t, id: parsed.id }
  } catch {
    return null
  }
}

function rowToEpisodeSummary(row: EpisodeRow): EpisodeSummary {
  return {
    episodeId: row.id,
    startAt: row.startAt,
    endAt: row.endAt,
    lastEventAt: row.lastEventAt,
    eventCount: row.eventCount,
    boundaryReason: (row.boundaryReason as EpisodeBoundaryReason | null) ?? "initial",
    profile: row.profile,
    project: row.project,
    session: row.session,
  }
}

function getAdjacentEpisodeId(
  hdb: HindsightDatabase,
  episodeId: string,
  direction: "before" | "after",
): string | null {
  if (direction === "before") {
    const row = hdb.sqlite
      .prepare(
        `SELECT from_episode_id AS episodeId
         FROM hs_episode_temporal_links
         WHERE to_episode_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(episodeId) as { episodeId: string } | undefined
    return row?.episodeId ?? null
  }

  const row = hdb.sqlite
    .prepare(
      `SELECT to_episode_id AS episodeId
       FROM hs_episode_temporal_links
       WHERE from_episode_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(episodeId) as { episodeId: string } | undefined
  return row?.episodeId ?? null
}

function collectEpisodeChain(
  hdb: HindsightDatabase,
  anchorEpisodeId: string,
  direction: "before" | "after",
  maxSteps: number,
): string[] {
  const chain: string[] = [anchorEpisodeId]
  const seen = new Set<string>([anchorEpisodeId])
  let cursor = anchorEpisodeId

  for (let i = 0; i < maxSteps; i++) {
    const nextId = getAdjacentEpisodeId(hdb, cursor, direction)
    if (!nextId) break
    if (seen.has(nextId)) break
    chain.push(nextId)
    seen.add(nextId)
    cursor = nextId
  }

  return chain
}

function buildEpisodeInClause(episodeIds: string[]): string {
  return episodeIds.map(() => "?").join(",")
}

export function detectBoundary(
  lastEpisode: EpisodeRow | null,
  now: number,
  profile: string | null,
  project: string | null,
  session: string | null,
  content?: string,
): { needsNew: boolean; reason: EpisodeBoundaryReason | null } {
  if (!lastEpisode) {
    return { needsNew: true, reason: "initial" }
  }

  if (content) {
    for (const pattern of BOUNDARY_PHRASES) {
      if (pattern.test(content)) {
        return { needsNew: true, reason: "phrase_boundary" }
      }
    }
  }

  if (
    lastEpisode.profile !== profile ||
    lastEpisode.project !== project ||
    lastEpisode.session !== session
  ) {
    return { needsNew: true, reason: "scope_change" }
  }

  if (now - lastEpisode.lastEventAt > EPISODE_GAP_MS) {
    return { needsNew: true, reason: "time_gap" }
  }

  return { needsNew: false, reason: null }
}

export function resolveEpisode(
  hdb: HindsightDatabase,
  bankId: string,
  now: number,
  profile: string | null,
  project: string | null,
  session: string | null,
  content?: string,
): string {
  const scopeConditions = [
    eq(hdb.schema.episodes.bankId, bankId),
    profile === null
      ? isNull(hdb.schema.episodes.profile)
      : eq(hdb.schema.episodes.profile, profile),
    project === null
      ? isNull(hdb.schema.episodes.project)
      : eq(hdb.schema.episodes.project, project),
    session === null
      ? isNull(hdb.schema.episodes.session)
      : eq(hdb.schema.episodes.session, session),
  ]

  const lastEpisode = hdb.db
    .select()
    .from(hdb.schema.episodes)
    .where(and(...scopeConditions))
    .orderBy(desc(hdb.schema.episodes.lastEventAt), desc(hdb.schema.episodes.id))
    .limit(1)
    .get() as EpisodeRow | undefined

  const { needsNew, reason } = detectBoundary(
    lastEpisode ?? null,
    now,
    profile,
    project,
    session,
    content,
  )

  if (!needsNew && lastEpisode) {
    return lastEpisode.id
  }

  if (lastEpisode) {
    hdb.db
      .update(hdb.schema.episodes)
      .set({ endAt: now, lastEventAt: now })
      .where(eq(hdb.schema.episodes.id, lastEpisode.id))
      .run()
  }

  const episodeId = ulid()
  hdb.db
    .insert(hdb.schema.episodes)
    .values({
      id: episodeId,
      bankId,
      profile,
      project,
      session,
      startAt: now,
      endAt: null,
      lastEventAt: now,
      eventCount: 0,
      boundaryReason: reason,
    })
    .run()

  if (lastEpisode) {
    hdb.db
      .insert(hdb.schema.episodeTemporalLinks)
      .values({
        id: ulid(),
        fromEpisodeId: lastEpisode.id,
        toEpisodeId: episodeId,
        reason: reason ?? "scope_change",
        gapMs: now - lastEpisode.lastEventAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run()
  }

  return episodeId
}

export function recordEpisodeEvent(
  hdb: HindsightDatabase,
  episodeId: string,
  bankId: string,
  memoryId: string,
  route: RetainRoute,
  now: number,
  profile: string | null,
  project: string | null,
  session: string | null,
): void {
  hdb.db
    .insert(hdb.schema.episodeEvents)
    .values({
      id: ulid(),
      episodeId,
      bankId,
      memoryId,
      eventTime: now,
      route,
      profile,
      project,
      session,
    })
    .run()

  hdb.db
    .update(hdb.schema.episodes)
    .set({
      lastEventAt: now,
      eventCount: sql`event_count + 1`,
    })
    .where(eq(hdb.schema.episodes.id, episodeId))
    .run()
}

function buildEpisodeConditions(
  schema: HindsightDatabase["schema"],
  bankId: string,
  options?: Pick<ListEpisodesOptions, "profile" | "project" | "session">,
) {
  const conditions = [eq(schema.episodes.bankId, bankId)]
  if (options?.profile !== undefined) {
    conditions.push(eq(schema.episodes.profile, options.profile))
  }
  if (options?.project !== undefined) {
    conditions.push(eq(schema.episodes.project, options.project))
  }
  if (options?.session !== undefined) {
    conditions.push(eq(schema.episodes.session, options.session))
  }
  return conditions
}

export function listEpisodes(
  hdb: HindsightDatabase,
  bankId: string,
  options?: Omit<ListEpisodesOptions, "bankId">,
): ListEpisodesResult {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100)
  const { schema } = hdb

  const conditions = buildEpisodeConditions(schema, bankId, options)

  if (options?.cursor) {
    const cursor = decodeCursor(options.cursor)
    if (cursor) {
      conditions.push(
        or(
          lt(schema.episodes.lastEventAt, cursor.t),
          and(
            eq(schema.episodes.lastEventAt, cursor.t),
            lt(schema.episodes.id, cursor.id),
          ),
        )!,
      )
    }
  }

  const where = conditions.length === 1 ? conditions[0]! : and(...conditions)

  const rows = hdb.db
    .select()
    .from(schema.episodes)
    .where(where)
    .orderBy(desc(schema.episodes.lastEventAt), desc(schema.episodes.id))
    .limit(limit + 1)
    .all() as EpisodeRow[]

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const items = pageRows.map(rowToEpisodeSummary)
  const cursor = hasMore && pageRows.length > 0
    ? encodeCursor({
        t: pageRows[pageRows.length - 1]!.lastEventAt,
        id: pageRows[pageRows.length - 1]!.id,
      })
    : null

  const totalConditions = buildEpisodeConditions(schema, bankId, options)
  const totalWhere =
    totalConditions.length === 1 ? totalConditions[0]! : and(...totalConditions)

  const totalRow = hdb.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.episodes)
    .where(totalWhere)
    .get() as { count: number }

  return {
    items,
    total: totalRow.count,
    limit,
    cursor,
  }
}

export function narrative(
  hdb: HindsightDatabase,
  bankId: string,
  options: Omit<NarrativeInput, "bankId">,
): NarrativeResult {
  const { anchorMemoryId, direction = "both", steps = NARRATIVE_STEPS_DEFAULT } = options
  const maxSteps = Math.min(Math.max(steps, 1), NARRATIVE_STEPS_MAX)

  const anchorEvent = hdb.db
    .select()
    .from(hdb.schema.episodeEvents)
    .where(
      and(
        eq(hdb.schema.episodeEvents.bankId, bankId),
        eq(hdb.schema.episodeEvents.memoryId, anchorMemoryId),
      ),
    )
    .orderBy(desc(hdb.schema.episodeEvents.eventTime), desc(hdb.schema.episodeEvents.id))
    .limit(1)
    .get()

  if (!anchorEvent) {
    return { events: [], anchorMemoryId }
  }

  const events: NarrativeEvent[] = []
  const anchorEpisodeId = anchorEvent.episodeId

  if (direction === "before" || direction === "both") {
    const episodeIds = collectEpisodeChain(hdb, anchorEpisodeId, "before", maxSteps)
    const inClause = buildEpisodeInClause(episodeIds)
    const beforeEvents = hdb.sqlite
      .prepare(
        `SELECT ee.id, ee.memory_id, ee.episode_id, ee.event_time, ee.route, COALESCE(mu.content, '[deleted]') AS content
         FROM hs_episode_events ee
         LEFT JOIN hs_memory_units mu ON mu.id = ee.memory_id
         WHERE ee.bank_id = ?
           AND ee.episode_id IN (${inClause})
           AND (ee.event_time < ? OR (ee.event_time = ? AND ee.id < ?))
         ORDER BY ee.event_time DESC, ee.id DESC
         LIMIT ?`,
      )
      .all(
        bankId,
        ...episodeIds,
        anchorEvent.eventTime,
        anchorEvent.eventTime,
        anchorEvent.id,
        maxSteps,
      ) as Array<{
      id: string
      memory_id: string
      episode_id: string
      event_time: number
      route: string
      content: string
    }>

    for (const row of beforeEvents.reverse()) {
      events.push({
        memoryId: row.memory_id,
        episodeId: row.episode_id,
        eventTime: row.event_time,
        route: row.route as RetainRoute,
        contentSnippet: toSnippet(row.content),
      })
    }
  }

  const anchorMemory = hdb.db
    .select({ content: hdb.schema.memoryUnits.content })
    .from(hdb.schema.memoryUnits)
    .where(eq(hdb.schema.memoryUnits.id, anchorMemoryId))
    .get()

  events.push({
    memoryId: anchorMemoryId,
    episodeId: anchorEpisodeId,
    eventTime: anchorEvent.eventTime,
    route: anchorEvent.route as RetainRoute,
    contentSnippet: toSnippet(anchorMemory?.content ?? ""),
  })

  if (direction === "after" || direction === "both") {
    const episodeIds = collectEpisodeChain(hdb, anchorEpisodeId, "after", maxSteps)
    const inClause = buildEpisodeInClause(episodeIds)
    const afterEvents = hdb.sqlite
      .prepare(
        `SELECT ee.id, ee.memory_id, ee.episode_id, ee.event_time, ee.route, COALESCE(mu.content, '[deleted]') AS content
         FROM hs_episode_events ee
         LEFT JOIN hs_memory_units mu ON mu.id = ee.memory_id
         WHERE ee.bank_id = ?
           AND ee.episode_id IN (${inClause})
           AND (ee.event_time > ? OR (ee.event_time = ? AND ee.id > ?))
         ORDER BY ee.event_time ASC, ee.id ASC
         LIMIT ?`,
      )
      .all(
        bankId,
        ...episodeIds,
        anchorEvent.eventTime,
        anchorEvent.eventTime,
        anchorEvent.id,
        maxSteps,
      ) as Array<{
      id: string
      memory_id: string
      episode_id: string
      event_time: number
      route: string
      content: string
    }>

    for (const row of afterEvents) {
      events.push({
        memoryId: row.memory_id,
        episodeId: row.episode_id,
        eventTime: row.event_time,
        route: row.route as RetainRoute,
        contentSnippet: toSnippet(row.content),
      })
    }
  }

  return { events, anchorMemoryId }
}
