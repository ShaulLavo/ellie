import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";

// ── SQLite Manager ──────────────────────────────────────────────────────────

export interface SQLiteManagerConfig {
  customLibPath?: string;
}

const EXT = process.platform === "darwin" ? "dylib" : "so";

const CUSTOM_LIB_PATHS = [
  resolve(import.meta.dirname, `../vendor/libsqlite3-vec.${EXT}`), // committed
  resolve(import.meta.dirname, `../dist/libsqlite3-vec.${EXT}`),   // build output
];

/**
 * Singleton managing SQLite library initialization with sqlite-vec.
 *
 * Requires either:
 * 1. Custom-compiled lib with vec statically linked (dist/libsqlite3-vec.*)
 * 2. The `sqlite-vec` npm package (loaded as a runtime extension)
 *
 * Throws on startup if neither is available.
 */
class SQLiteManager {
  private static _instance: SQLiteManager | undefined;

  private initialized = false;
  private needsLoadExtension = false;

  private readonly customLibPath: string | undefined;

  private constructor(config: SQLiteManagerConfig = {}) {
    this.customLibPath = config.customLibPath ?? CUSTOM_LIB_PATHS.find(existsSync);
  }

  static get instance(): SQLiteManager {
    SQLiteManager._instance ??= new SQLiteManager();
    return SQLiteManager._instance;
  }

  /**
   * Reconfigure the singleton before first use.
   * Must be called before any `openDatabase()` call.
   */
  static configure(config: SQLiteManagerConfig): void {
    if (SQLiteManager._instance?.initialized) {
      throw new Error(
        "[db] Cannot configure SQLiteManager after initialization. " +
        "Call configure() before any openDatabase() call.",
      );
    }
    SQLiteManager._instance = new SQLiteManager(config);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.customLibPath) {
      try {
        Database.setCustomSQLite(this.customLibPath);
      } catch {
        // Already loaded (e.g. HMR reload) — safe to ignore
      }

      // Verify the custom lib actually took effect by checking for vec0.
      // On some platforms/Bun versions, setCustomSQLite silently no-ops.
      if (this.verifyVec0()) return;
    }

    // Custom lib not available or didn't load — fall back to sqlite-vec npm package.
    // Use require() for synchronous loading since open() is a sync API.
    // Bun supports require() in ESM natively; dynamic import() would force async.
    try {
      require("sqlite-vec");
    } catch {
      throw new Error(
        `[db] sqlite-vec is required but not available.\n` +
        `  Tried custom libs: ${CUSTOM_LIB_PATHS.join(", ")}\n` +
        `  Tried npm package: sqlite-vec (not found)\n` +
        `  Fix: run 'bun run build' in packages/db to compile the custom lib,\n` +
        `       or install the package with: bun add sqlite-vec`,
      );
    }

    this.needsLoadExtension = true;
  }

  /** Quick probe: can a fresh connection use vec0? */
  private verifyVec0(): boolean {
    const db = new Database(":memory:");
    try {
      db.run(
        "CREATE VIRTUAL TABLE _vec_probe USING vec0(id TEXT PRIMARY KEY, v float[4])",
      );
      db.run("DROP TABLE _vec_probe");
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  open(dbPath: string): Database {
    this.init();

    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");

    if (this.needsLoadExtension) {
      // require() was already verified to succeed in init()
      const vec = require("sqlite-vec") as typeof import("sqlite-vec");
      vec.load(db);
    }

    return db;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export { SQLiteManager };

export function initCustomSQLite(): void {
  SQLiteManager.instance.init();
}

export function openDatabase(dbPath: string): Database {
  return SQLiteManager.instance.open(dbPath);
}
