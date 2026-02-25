import { openSync, closeSync, writeSync, readSync, statSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { constants } from 'fs'

// Pre-allocated newline byte — avoids per-append allocation
const NEWLINE = new Uint8Array([0x0a])

/**
 * JSONL log file writer/reader.
 *
 * Each append writes `data + "\n"` to the file. Records are identified by
 * their byte position and length within the file.
 *
 * Writes use O_APPEND for atomic appends. Reads use pread-style positioned
 * reads (via readSync with position) — no seeking required.
 */
export class LogFile {
	private fd: number
	private currentSize: number

	constructor(filePath: string) {
		// Ensure parent directory exists
		mkdirSync(dirname(filePath), { recursive: true })

		// Open for append + read. Create if not exists.
		this.fd = openSync(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND)

		// Track current file size for byte position calculation
		this.currentSize = statSync(filePath).size
	}

	/**
	 * Append data as a single JSONL line.
	 * Returns the byte position and length of the written record.
	 */
	append(data: Uint8Array): { bytePos: number; length: number } {
		const bytePos = this.currentSize

		// Two writeSync calls are safe: writeSync blocks the event loop,
		// so no other JS can interleave in this single-threaded process.
		writeSync(this.fd, data)
		writeSync(this.fd, NEWLINE)
		this.currentSize += data.length + 1

		return { bytePos, length: data.length }
	}

	/**
	 * Read a single record at a byte position.
	 * Returns the raw bytes (without the trailing newline).
	 */
	readAt(bytePos: number, length: number): Uint8Array {
		const buf = new Uint8Array(length)
		readSync(this.fd, buf, 0, length, bytePos)
		return buf
	}

	/**
	 * Read multiple records by their byte positions.
	 * Convenience wrapper — calls readAt for each entry.
	 */
	readRange(entries: Array<{ bytePos: number; length: number }>): Uint8Array[] {
		return entries.map(e => this.readAt(e.bytePos, e.length))
	}

	/**
	 * Read all bytes from a position to the end of file.
	 * Useful for catch-up reads where you want everything after a point.
	 */
	readFrom(bytePos: number): Uint8Array {
		const remaining = this.currentSize - bytePos
		if (remaining <= 0) return new Uint8Array(0)

		const buf = new Uint8Array(remaining)
		readSync(this.fd, buf, 0, remaining, bytePos)
		return buf
	}

	/** Current file size in bytes. */
	get size(): number {
		return this.currentSize
	}

	/** Close the file descriptor. Safe to call multiple times. */
	close(): void {
		if (this.fd !== -1) {
			closeSync(this.fd)
			this.fd = -1
		}
	}
}
