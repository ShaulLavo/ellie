import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { resolve } from "path"

// ── Custom SQLite with sqlite-vec ────────────────────────────────────────────

const EXT = process.platform === "darwin" ? "dylib" : "so"
const CUSTOM_LIB = resolve(import.meta.dirname, `../dist/libsqlite3-vec.${EXT}`)

// macOS-only Homebrew fallback paths. On Linux, the custom-compiled lib
// (dist/libsqlite3-vec.*) must be provided — there is no automatic fallback.
const FALLBACK_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // macOS ARM (Homebrew)
  "/usr/local/opt/sqlite3/lib/libsqlite3.dylib", // macOS Intel (Homebrew)
]

let needsLoadExtension = false
let sqliteInitialized = false
let vecAvailable = false

/**
 * Initialize the custom SQLite library with sqlite-vec support.
 * Called once automatically by `openDatabase()`.
 *
 * Priority:
 * 1. Custom-compiled lib with vec statically linked (dist/libsqlite3-vec.*)
 * 2. Homebrew SQLite + runtime vec extension loading
 * 3. Bun's built-in SQLite (no vec support)
 */
export function initCustomSQLite(): void {
  if (sqliteInitialized) return
  sqliteInitialized = true

  if (existsSync(CUSTOM_LIB)) {
    Database.setCustomSQLite(CUSTOM_LIB)
    vecAvailable = true
    return
  }

  for (const p of FALLBACK_PATHS) {
    if (existsSync(p)) {
      Database.setCustomSQLite(p)
      needsLoadExtension = true
      // Don't set vecAvailable here — it's only confirmed when sqlite-vec
      // actually loads successfully in openDatabase()
      return
    }
  }

  // No custom lib found — use Bun's built-in SQLite (no vec support)
  console.warn(
    `[db] Custom SQLite with vec not found. Vector operations will not be available.`
  )
  console.warn(
    `[db] Run 'bun run build' in packages/db to compile sqlite-vec.`
  )
}

/**
 * Whether sqlite-vec is available for vector operations.
 */
export function isVecAvailable(): boolean {
  initCustomSQLite()
  return vecAvailable
}

/**
 * Open a SQLite database with WAL mode, foreign keys, and sqlite-vec if available.
 */
export function openDatabase(dbPath: string): Database {
  initCustomSQLite()

  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA foreign_keys=ON")

  if (needsLoadExtension) {
    try {
      const sqliteVec = require("sqlite-vec") as typeof import("sqlite-vec")
      sqliteVec.load(db)
      vecAvailable = true
    } catch (err) {
      vecAvailable = false
      console.warn(
        `[db] sqlite-vec package not found. Install it with: bun add sqlite-vec`,
      )
    }
  }

  return db
}
