/**
 * Runtime allowFrom persistence.
 * Stores approved senders separately from config-file allowFrom,
 * so pairing approvals survive restarts without editing settings.
 *
 * Store path: DATA_DIR/channels/whatsapp/<accountId>/allowFrom.json
 */

import {
	readFileSync,
	writeFileSync,
	mkdirSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { normalizeE164 } from './normalize'

function storePath(
	dataDir: string,
	accountId: string
): string {
	return join(
		dataDir,
		'channels',
		'whatsapp',
		accountId,
		'allowFrom.json'
	)
}

export function readAllowFrom(
	dataDir: string,
	accountId: string
): string[] {
	try {
		return JSON.parse(
			readFileSync(storePath(dataDir, accountId), 'utf8')
		) as string[]
	} catch {
		return []
	}
}

export function addAllowFrom(
	dataDir: string,
	accountId: string,
	entry: string
): void {
	const path = storePath(dataDir, accountId)
	const store = readAllowFrom(dataDir, accountId)
	const normalized = normalizeE164(entry)
	if (store.some(e => normalizeE164(e) === normalized))
		return
	store.push(normalized)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(store, null, 2))
}

export function removeAllowFrom(
	dataDir: string,
	accountId: string,
	entry: string
): void {
	const path = storePath(dataDir, accountId)
	const store = readAllowFrom(dataDir, accountId)
	const normalized = normalizeE164(entry)
	const filtered = store.filter(
		e => normalizeE164(e) !== normalized
	)
	if (filtered.length === store.length) return
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(filtered, null, 2))
}

/**
 * Merge config allowFrom + runtime store allowFrom, deduped by normalized E.164.
 */
export function mergedAllowFrom(
	configAllowFrom: string[],
	dataDir: string,
	accountId: string
): string[] {
	const storeEntries = readAllowFrom(dataDir, accountId)
	const seen = new Set<string>()
	const result: string[] = []
	for (const entry of [
		...configAllowFrom,
		...storeEntries
	]) {
		const key = entry === '*' ? '*' : normalizeE164(entry)
		if (!seen.has(key)) {
			seen.add(key)
			result.push(key)
		}
	}
	return result
}
