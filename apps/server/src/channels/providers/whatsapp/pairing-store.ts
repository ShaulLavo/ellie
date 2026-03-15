/**
 * Pairing request persistence for the `pairing` DM policy.
 * Stores pending pairing requests with human-friendly codes.
 */

import {
	readFileSync,
	writeFileSync,
	mkdirSync
} from 'node:fs'
import { join, dirname } from 'node:path'

export type PairingRequest = {
	/** Normalized sender E.164 */
	id: string
	/** 8-char human-friendly code (no ambiguous chars) */
	code: string
	/** ISO timestamp */
	createdAt: string
	/** ISO timestamp — updated on repeat contact */
	lastSeenAt: string
	/** Account the request is for */
	accountId?: string
	/** Optional sender metadata */
	meta?: { name?: string }
}

// Characters excluding ambiguous 0/O/1/I/l
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const MAX_PENDING = 3
const TTL_MS = 60 * 60 * 1000 // 1 hour

function storePath(
	dataDir: string,
	accountId: string
): string {
	return join(
		dataDir,
		'channels',
		'whatsapp',
		accountId,
		'pairing.json'
	)
}

function readStore(path: string): PairingRequest[] {
	try {
		return JSON.parse(
			readFileSync(path, 'utf8')
		) as PairingRequest[]
	} catch {
		return []
	}
}

function writeStore(
	path: string,
	data: PairingRequest[]
): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(data, null, 2))
}

function generateCode(): string {
	let code = ''
	for (let i = 0; i < CODE_LENGTH; i++) {
		code +=
			CODE_CHARS[
				Math.floor(Math.random() * CODE_CHARS.length)
			]
	}
	return code
}

function isExpired(req: PairingRequest): boolean {
	return (
		Date.now() - new Date(req.createdAt).getTime() > TTL_MS
	)
}

/**
 * Upsert a pairing request for an unknown sender.
 * - If the sender already has a pending (non-expired) request, updates lastSeenAt and returns created: false
 * - If new, generates a code and creates the request (evicting oldest if at max capacity)
 */
export function upsertPairingRequest(params: {
	dataDir: string
	accountId: string
	senderId: string
	meta?: { name?: string }
}): { code: string; created: boolean } {
	const path = storePath(params.dataDir, params.accountId)
	let store = readStore(path)

	// Purge expired
	store = store.filter(r => !isExpired(r))

	// Check for existing request from this sender
	const existing = store.find(r => r.id === params.senderId)
	if (existing) {
		existing.lastSeenAt = new Date().toISOString()
		if (params.meta?.name) {
			existing.meta = { ...existing.meta, ...params.meta }
		}
		writeStore(path, store)
		return { code: existing.code, created: false }
	}

	// Evict oldest if at capacity
	while (store.length >= MAX_PENDING) {
		store.shift()
	}

	// Generate unique code
	let code: string
	do {
		code = generateCode()
	} while (store.some(r => r.code === code))

	const now = new Date().toISOString()
	store.push({
		id: params.senderId,
		code,
		createdAt: now,
		lastSeenAt: now,
		accountId: params.accountId,
		meta: params.meta
	})

	writeStore(path, store)
	return { code, created: true }
}

/**
 * Approve a pairing request by code.
 * Returns the sender ID if found, or null if the code doesn't match any pending request.
 */
export function approvePairingCode(params: {
	dataDir: string
	accountId: string
	code: string
}): { id: string } | null {
	const path = storePath(params.dataDir, params.accountId)
	let store = readStore(path)

	// Purge expired
	store = store.filter(r => !isExpired(r))

	const idx = store.findIndex(
		r => r.code.toUpperCase() === params.code.toUpperCase()
	)
	if (idx === -1) {
		writeStore(path, store)
		return null
	}

	const [removed] = store.splice(idx, 1)
	writeStore(path, store)
	return { id: removed.id }
}

/**
 * List all pending (non-expired) pairing requests for an account.
 */
export function listPairingRequests(params: {
	dataDir: string
	accountId: string
}): PairingRequest[] {
	const path = storePath(params.dataDir, params.accountId)
	const store = readStore(path).filter(r => !isExpired(r))
	return store
}
