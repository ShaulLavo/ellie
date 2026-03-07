import { and, eq, lte } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import {
	speechArtifacts,
	type SpeechArtifactRow,
	type NewSpeechArtifactRow
} from './schema'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBunSQLiteDB = BunSQLiteDatabase<any>

export class SpeechArtifactStore {
	#db: AnyBunSQLiteDB
	constructor(db: AnyBunSQLiteDB) {
		this.#db = db
	}

	/** Insert a new draft speech artifact. */
	create(row: NewSpeechArtifactRow): SpeechArtifactRow {
		return this.#db
			.insert(speechArtifacts)
			.values(row)
			.returning()
			.get()
	}

	/** Get artifact by ID. */
	get(id: string): SpeechArtifactRow | undefined {
		return this.#db
			.select()
			.from(speechArtifacts)
			.where(eq(speechArtifacts.id, id))
			.get()
	}

	/**
	 * Claim a draft artifact for a user_message event.
	 * Returns the updated row, or undefined if not in draft status.
	 */
	claim(
		id: string,
		eventId: number,
		sessionId: string
	): SpeechArtifactRow | undefined {
		const rows = this.#db
			.update(speechArtifacts)
			.set({
				status: 'claimed',
				claimedAt: Date.now(),
				claimedByEventId: eventId,
				claimedBySessionId: sessionId
			})
			.where(
				and(
					eq(speechArtifacts.id, id),
					eq(speechArtifacts.status, 'draft')
				)
			)
			.returning()
			.all()

		return rows[0]
	}

	/**
	 * Expire stale draft artifacts whose expiresAt is before `now`.
	 * Returns the number of artifacts expired.
	 */
	expireDrafts(now: number): number {
		const result = this.#db
			.update(speechArtifacts)
			.set({ status: 'expired' })
			.where(
				and(
					eq(speechArtifacts.status, 'draft'),
					lte(speechArtifacts.expiresAt, now)
				)
			)
			.returning({ id: speechArtifacts.id })
			.all()

		return result.length
	}

	/**
	 * Delete expired artifacts and return their blob paths for filesystem cleanup.
	 */
	deleteExpired(): string[] {
		const rows = this.#db
			.delete(speechArtifacts)
			.where(eq(speechArtifacts.status, 'expired'))
			.returning({ blobPath: speechArtifacts.blobPath })
			.all()

		return rows.map(r => r.blobPath)
	}
}
