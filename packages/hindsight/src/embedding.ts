import type { Database } from "bun:sqlite"
import type { EmbedFunction } from "./types"

/**
 * Thin wrapper around sqlite-vec's vec0 virtual tables.
 *
 * Handles upsert, KNN search, and deletion for a single vec0 table.
 */
export class EmbeddingStore {
  constructor(
    private readonly sqlite: Database,
    private readonly embed: EmbedFunction,
    private readonly dims: number,
    private readonly tableName: string,
  ) {}

  /** Generate an embedding and store it in the vec0 table. */
  async upsert(id: string, text: string): Promise<void> {
    const vector = await this.embed(text)
    const floats = new Float32Array(vector)

    // vec0 doesn't support ON CONFLICT — delete then insert
    this.sqlite.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id])
    this.sqlite
      .prepare(`INSERT INTO ${this.tableName} (id, embedding) VALUES (?, ?)`)
      .run(id, floats)
  }

  /** KNN search: returns the k nearest neighbors by cosine distance. */
  async search(
    query: string,
    k: number,
  ): Promise<Array<{ id: string; distance: number }>> {
    const vector = await this.embed(query)
    const floats = new Float32Array(vector)

    return this.sqlite
      .prepare(
        `
        SELECT id, vec_distance_cosine(embedding, ?) as distance
        FROM ${this.tableName}
        WHERE embedding MATCH ?
        AND k = ?
        ORDER BY distance ASC
      `,
      )
      .all(floats, floats, k) as Array<{ id: string; distance: number }>
  }

  /** Delete an embedding by ID. */
  delete(id: string): void {
    this.sqlite.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id])
  }
}
