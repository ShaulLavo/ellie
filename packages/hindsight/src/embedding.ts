import type { Database } from 'bun:sqlite'
import type {
	EmbedBatchFunction,
	EmbedFunction
} from './types'

/**
 * Thin wrapper around sqlite-vec's vec0 virtual tables.
 *
 * Handles upsert, KNN search, and deletion for a single vec0 table.
 */
export class EmbeddingStore {
	readonly sqlite: Database
	readonly embed: EmbedFunction
	readonly embedBatch: EmbedBatchFunction | undefined
	readonly dims: number
	readonly tableName: string

	constructor(
		sqlite: Database,
		embed: EmbedFunction,
		embedBatch: EmbedBatchFunction | undefined,
		dims: number,
		tableName: string
	) {
		this.sqlite = sqlite
		this.embed = embed
		this.embedBatch = embedBatch
		this.dims = dims
		this.tableName = tableName
	}

	/** Generate an embedding and store it in the vec0 table. */
	async upsert(id: string, text: string): Promise<void> {
		const vectors = await this.createVectors([text])
		this.upsertVectors([{ id, vector: vectors[0]! }])
	}

	/** Generate embeddings for multiple texts in one batch when possible. */
	async createVectors(
		texts: string[]
	): Promise<Float32Array[]> {
		if (texts.length === 0) return []

		const rawVectors = this.embedBatch
			? await this.embedBatch(texts)
			: await Promise.all(
					texts.map(text => this.embed(text))
				)

		if (rawVectors.length !== texts.length) {
			throw new Error(
				`Embedding batch size mismatch: expected ${texts.length}, got ${rawVectors.length}`
			)
		}

		return rawVectors.map(vector => {
			if (vector.length !== this.dims) {
				throw new Error(
					`Embedding dimension mismatch: expected ${this.dims}, got ${vector.length}`
				)
			}
			return new Float32Array(vector)
		})
	}

	/**
	 * Upsert precomputed vectors into the vec table.
	 * Useful for batching writes inside a larger transaction.
	 */
	upsertVectors(
		items: Array<{ id: string; vector: Float32Array }>
	): void {
		if (items.length === 0) return

		const insert = this.sqlite.prepare(
			`INSERT INTO ${this.tableName} (id, embedding) VALUES (?, ?)`
		)

		// Wrap in SAVEPOINT for atomicity (supports nesting inside existing transactions)
		this.sqlite.exec('SAVEPOINT vec_upsert')
		try {
			for (const item of items) {
				if (item.vector.length !== this.dims) {
					throw new Error(
						`Embedding dimension mismatch: expected ${this.dims}, got ${item.vector.length}`
					)
				}

				// vec0 doesn't support ON CONFLICT — delete then insert
				this.sqlite.run(
					`DELETE FROM ${this.tableName} WHERE id = ?`,
					[item.id]
				)
				insert.run(item.id, item.vector)
			}
			this.sqlite.exec('RELEASE vec_upsert')
		} catch (error) {
			this.sqlite.exec('ROLLBACK TO vec_upsert')
			throw error
		}
	}

	/** Generate embeddings and upsert them in one call. */
	async upsertMany(
		items: Array<{ id: string; text: string }>
	): Promise<void> {
		if (items.length === 0) return

		const vectors = await this.createVectors(
			items.map(item => item.text)
		)
		this.upsertVectors(
			items.map((item, index) => ({
				id: item.id,
				vector: vectors[index]!
			}))
		)
	}

	/** KNN search: returns the k nearest neighbors by cosine distance. */
	async search(
		query: string,
		k: number
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
      `
			)
			.all(floats, floats, k) as Array<{
			id: string
			distance: number
		}>
	}

	/** KNN search with a precomputed vector (avoids re-embedding query text). */
	searchByVector(
		vector: Float32Array,
		k: number
	): Array<{ id: string; distance: number }> {
		if (vector.length !== this.dims) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.dims}, got ${vector.length}`
			)
		}

		return this.sqlite
			.prepare(
				`
        SELECT id, vec_distance_cosine(embedding, ?) as distance
        FROM ${this.tableName}
        WHERE embedding MATCH ?
        AND k = ?
        ORDER BY distance ASC
      `
			)
			.all(vector, vector, k) as Array<{
			id: string
			distance: number
		}>
	}

	/** Delete an embedding by ID. */
	delete(id: string): void {
		this.sqlite.run(
			`DELETE FROM ${this.tableName} WHERE id = ?`,
			[id]
		)
	}
}
