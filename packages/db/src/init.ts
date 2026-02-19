import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { resolve } from "path"

// ── SQLite Manager ──────────────────────────────────────────────────────────

export interface SQLiteManagerConfig {
  customLibPath?: string
  fallbackPaths?: string[]
}

const EXT = process.platform === "darwin" ? "dylib" : "so"

const DEFAULTS = {
  customLibPath: resolve(import.meta.dirname, `../dist/libsqlite3-vec.${EXT}`),
  // macOS-only Homebrew fallback paths. On Linux, the custom-compiled lib
  // (dist/libsqlite3-vec.*) must be provided — there is no automatic fallback.
  fallbackPaths: [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // macOS ARM (Homebrew)
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib", // macOS Intel (Homebrew)
  ],
} satisfies Required<SQLiteManagerConfig>

/**
 * Singleton managing SQLite library initialization and sqlite-vec availability.
 *
 * Priority for SQLite library selection:
 * 1. Custom-compiled lib with vec statically linked (dist/libsqlite3-vec.*)
 * 2. Homebrew SQLite + runtime vec extension loading
 * 3. Bun's built-in SQLite (no vec support)
 */
class SQLiteManager {
  private static _instance: SQLiteManager | undefined

  private initialized = false
  private needsLoadExtension = false
  private _vecAvailable = false

  private readonly customLibPath: string
  private readonly fallbackPaths: readonly string[]

  private constructor(config: SQLiteManagerConfig = {}) {
    this.customLibPath = config.customLibPath ?? DEFAULTS.customLibPath
    this.fallbackPaths = config.fallbackPaths ?? DEFAULTS.fallbackPaths
  }

  static get instance(): SQLiteManager {
    SQLiteManager._instance ??= new SQLiteManager()
    return SQLiteManager._instance
  }

  /**
   * Reconfigure the singleton before first use.
   * Must be called before any `openDatabase()` or `isVecAvailable()` call.
   */
  static configure(config: SQLiteManagerConfig): void {
    if (SQLiteManager._instance?.initialized) {
      throw new Error(
        "[db] Cannot configure SQLiteManager after initialization. " +
          "Call configure() before any openDatabase() or isVecAvailable() call.",
      )
    }
    SQLiteManager._instance = new SQLiteManager(config)
  }

  get vecAvailable(): boolean {
    this.init()
    return this._vecAvailable
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    if (existsSync(this.customLibPath)) {
      Database.setCustomSQLite(this.customLibPath)
      this._vecAvailable = true
      return
    }

    for (const p of this.fallbackPaths) {
      if (existsSync(p)) {
        Database.setCustomSQLite(p)
        this.needsLoadExtension = true
        // Don't set vecAvailable here — it's only confirmed when sqlite-vec
        // actually loads successfully in open()
        return
      }
    }

    // No custom lib found — use Bun's built-in SQLite (no vec support)
    console.warn(
      `[db] Custom SQLite with vec not found. Vector operations will not be available.`,
    )
    console.warn(
      `[db] Run 'bun run build' in packages/db to compile sqlite-vec.`,
    )
  }

  open(dbPath: string): Database {
    this.init()

    const db = new Database(dbPath)
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA foreign_keys=ON")

    if (this.needsLoadExtension) {
      try {
        // sqlite-vec is an optional dependency — use require() for synchronous
        // loading since openDatabase() is a sync API. Bun supports require()
        // in ESM natively; a dynamic import() would force this to be async.
        const vec = require("sqlite-vec") as typeof import("sqlite-vec")
        vec.load(db)
        this._vecAvailable = true
      } catch {
        this._vecAvailable = false
        console.warn(
          `[db] sqlite-vec package not found. Install it with: bun add sqlite-vec`,
        )
      }
    }

    return db
  }
}

// ── Public API (unchanged) ──────────────────────────────────────────────────

export { SQLiteManager }

export function initCustomSQLite(): void {
  SQLiteManager.instance.init()
}

export function isVecAvailable(): boolean {
  return SQLiteManager.instance.vecAvailable
}

export function openDatabase(dbPath: string): Database {
  return SQLiteManager.instance.open(dbPath)
}
