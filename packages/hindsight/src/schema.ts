import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core"

// ── Banks ──────────────────────────────────────────────────────────────────

export const banks = sqliteTable("hs_banks", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  config: text("config"), // JSON BankConfig
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

// ── Memory Units ───────────────────────────────────────────────────────────

export const memoryUnits = sqliteTable(
  "hs_memory_units",
  {
    id: text("id").primaryKey(),
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    factType: text("fact_type").notNull(), // world | experience | opinion | observation
    confidence: real("confidence").notNull().default(1.0),
    validFrom: integer("valid_from"), // epoch ms, nullable for atemporal facts
    validTo: integer("valid_to"), // epoch ms, null = still valid
    metadata: text("metadata"), // JSON blob
    tags: text("tags"), // JSON array of strings
    sourceText: text("source_text"), // original text this was extracted from
    mentionedAt: integer("mentioned_at"), // epoch ms — when the content was mentioned (vs when stored)
    consolidatedAt: integer("consolidated_at"), // epoch ms — when this memory was processed by consolidation
    proofCount: integer("proof_count").notNull().default(0), // observations: number of supporting facts
    sourceMemoryIds: text("source_memory_ids"), // observations: JSON array of ULID refs
    history: text("history"), // observations: JSON array of change entries
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_hs_mu_bank").on(table.bankId),
    index("idx_hs_mu_fact_type").on(table.bankId, table.factType),
    index("idx_hs_mu_temporal").on(
      table.bankId,
      table.validFrom,
      table.validTo,
    ),
    index("idx_hs_mu_consolidated").on(table.bankId, table.consolidatedAt),
  ],
)

// ── Entities ───────────────────────────────────────────────────────────────

export const entities = sqliteTable(
  "hs_entities",
  {
    id: text("id").primaryKey(),
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    entityType: text("entity_type").notNull(), // person | organization | place | concept | other
    description: text("description"),
    metadata: text("metadata"), // JSON blob
    mentionCount: integer("mention_count").notNull().default(0),
    firstSeen: integer("first_seen").notNull(),
    lastUpdated: integer("last_updated").notNull(),
  },
  (table) => [
    index("idx_hs_ent_bank_name").on(table.bankId, table.name),
    index("idx_hs_ent_type").on(table.bankId, table.entityType),
  ],
)

// ── Memory ↔ Entity junction ───────────────────────────────────────────────

export const memoryEntities = sqliteTable(
  "hs_memory_entities",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryUnits.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.entityId] }),
    index("idx_hs_me_entity").on(table.entityId),
  ],
)

// ── Memory Links ───────────────────────────────────────────────────────────

export const memoryLinks = sqliteTable(
  "hs_memory_links",
  {
    id: text("id").primaryKey(),
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => memoryUnits.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => memoryUnits.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull(), // temporal | semantic | entity | causes | caused_by | enables | prevents
    weight: real("weight").notNull().default(1.0),
    metadata: text("metadata"), // JSON blob
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_hs_link_source").on(table.sourceId),
    index("idx_hs_link_target").on(table.targetId),
    index("idx_hs_link_bank_type").on(table.bankId, table.linkType),
  ],
)

// ── Entity Co-occurrences ──────────────────────────────────────────────────

export const entityCooccurrences = sqliteTable(
  "hs_entity_cooccurrences",
  {
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    entityA: text("entity_a")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    entityB: text("entity_b")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    count: integer("count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.entityA, table.entityB] }),
    index("idx_hs_cooc_bank").on(table.bankId),
  ],
)

// ── Mental Models ─────────────────────────────────────────────────────────

export const mentalModels = sqliteTable(
  "hs_mental_models",
  {
    id: text("id").primaryKey(),
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceQuery: text("source_query").notNull(),
    content: text("content"), // synthesized answer
    sourceMemoryIds: text("source_memory_ids"), // JSON array of ULID refs
    tags: text("tags"), // JSON array for scoping
    autoRefresh: integer("auto_refresh").notNull().default(0), // 0=false, 1=true
    lastRefreshedAt: integer("last_refreshed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_hs_mm_bank").on(table.bankId),
    index("idx_hs_mm_bank_name").on(table.bankId, table.name),
  ],
)

// ── Directives ──────────────────────────────────────────────────────────

export const directives = sqliteTable(
  "hs_directives",
  {
    id: text("id").primaryKey(),
    bankId: text("bank_id")
      .notNull()
      .references(() => banks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull(),
    priority: integer("priority").notNull().default(0),
    isActive: integer("is_active").notNull().default(1), // 0=false, 1=true
    tags: text("tags"), // JSON string[]
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_hs_dir_bank").on(table.bankId),
    index("idx_hs_dir_bank_active").on(table.bankId, table.isActive),
  ],
)

// ── Type exports ───────────────────────────────────────────────────────────

export type BankRow = typeof banks.$inferSelect
export type NewBankRow = typeof banks.$inferInsert
export type MemoryUnitRow = typeof memoryUnits.$inferSelect
export type NewMemoryUnitRow = typeof memoryUnits.$inferInsert
export type EntityRow = typeof entities.$inferSelect
export type NewEntityRow = typeof entities.$inferInsert
export type MemoryEntityRow = typeof memoryEntities.$inferSelect
export type MemoryLinkRow = typeof memoryLinks.$inferSelect
export type NewMemoryLinkRow = typeof memoryLinks.$inferInsert
export type EntityCooccurrenceRow = typeof entityCooccurrences.$inferSelect
export type MentalModelRow = typeof mentalModels.$inferSelect
export type NewMentalModelRow = typeof mentalModels.$inferInsert
export type DirectiveRow = typeof directives.$inferSelect
export type NewDirectiveRow = typeof directives.$inferInsert
