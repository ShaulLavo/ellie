#!/usr/bin/env bash
#
# Build a custom SQLite shared library with sqlite-vec statically linked.
# This eliminates the need for runtime loadExtension() and Homebrew SQLite.
#
# Usage:
#   ./scripts/build-sqlite.sh          # build for current platform
#   FORCE_REBUILD=1 ./scripts/build-sqlite.sh  # force rebuild
#
# Output:
#   dist/libsqlite3-vec.dylib  (macOS)
#   dist/libsqlite3-vec.so     (Linux)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PKG_DIR/.build-sqlite"
OUT_DIR="$PKG_DIR/dist"

# Versions — pin these for reproducibility
#
# To update SQLite:
#   1. Visit https://www.sqlite.org/download.html
#   2. Find the "amalgamation" zip under "Source Code"
#   3. The URL contains the year and version number:
#      https://www.sqlite.org/{YEAR}/sqlite-amalgamation-{VERSION}.zip
#      e.g. 3450300 = 3.45.3 (major*1000000 + minor*1000 + patch*100)
#   4. Update SQLITE_YEAR and SQLITE_VERSION below
#
# To update sqlite-vec:
#   1. Visit https://github.com/asg017/sqlite-vec/releases
#   2. Update SQLITE_VEC_VERSION to the latest release tag (without 'v' prefix)
#
# After updating, run: FORCE_REBUILD=1 ./scripts/build-sqlite.sh
SQLITE_YEAR="${SQLITE_YEAR:-2024}"
SQLITE_VERSION="${SQLITE_VERSION:-3450300}"
SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-0.1.6}"

# Derived URLs
SQLITE_URL="https://www.sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VERSION}.zip"
SQLITE_VEC_URL="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION}-amalgamation.zip"

OS="$(uname -s)"
ARCH="$(uname -m)"

echo "[build-sqlite] Platform: ${OS}/${ARCH}"
echo "[build-sqlite] SQLite version: ${SQLITE_VERSION}"
echo "[build-sqlite] sqlite-vec version: ${SQLITE_VEC_VERSION}"

# --- Platform-specific flags ---
case "$OS" in
  Darwin)
    EXT="dylib"
    SHARED_FLAGS="-dynamiclib -Wl,-install_name,@rpath/libsqlite3-vec.dylib"
    ;;
  Linux)
    EXT="so"
    SHARED_FLAGS="-shared -Wl,-soname,libsqlite3-vec.so"
    ;;
  *)
    echo "[build-sqlite] Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# NEON on ARM, no special flag needed on x86 (sqlite-vec auto-detects SSE)
SIMD_FLAGS=""
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  SIMD_FLAGS="-DSQLITE_VEC_ENABLE_NEON"
fi

OUT_LIB="$OUT_DIR/libsqlite3-vec.${EXT}"

# --- Check if already built ---
if [ -f "$OUT_LIB" ] && [ "${FORCE_REBUILD:-}" != "1" ]; then
  echo "[build-sqlite] $OUT_LIB already exists. Set FORCE_REBUILD=1 to rebuild."
  exit 0
fi

# --- Download sources ---
mkdir -p "$BUILD_DIR" "$OUT_DIR"

if [ ! -f "$BUILD_DIR/sqlite3.c" ]; then
  echo "[build-sqlite] Downloading SQLite amalgamation..."
  curl -fsSL "$SQLITE_URL" -o "$BUILD_DIR/sqlite.zip"
  unzip -jo "$BUILD_DIR/sqlite.zip" -d "$BUILD_DIR"
  rm "$BUILD_DIR/sqlite.zip"
fi

if [ ! -f "$BUILD_DIR/sqlite-vec.c" ]; then
  echo "[build-sqlite] Downloading sqlite-vec amalgamation..."
  curl -fsSL "$SQLITE_VEC_URL" -o "$BUILD_DIR/sqlite-vec.zip"
  unzip -jo "$BUILD_DIR/sqlite-vec.zip" -d "$BUILD_DIR"
  rm "$BUILD_DIR/sqlite-vec.zip"
fi

# --- Write the init shim ---
# This auto-registers sqlite-vec functions when SQLite initializes.
cat > "$BUILD_DIR/vec_init.c" << 'EOF'
#include "sqlite3.h"
#include "sqlite-vec.h"

/* Auto-register sqlite-vec on every new connection */
static int vec_auto_init(
  sqlite3 *db,
  char **pzErrMsg,
  const sqlite3_api_routines *pApi
) {
  return sqlite3_vec_init(db, pzErrMsg, pApi);
}

/* Called once at library load via SQLITE_EXTRA_INIT */
int core_init(const char *dummy) {
  return sqlite3_auto_extension((void (*)(void))vec_auto_init);
}
EOF

# --- Compile ---
echo "[build-sqlite] Compiling..."

CC="${CC:-cc}"

$CC \
  $SHARED_FLAGS \
  -fPIC -O2 \
  -I"$BUILD_DIR" \
  -DSQLITE_CORE \
  -DSQLITE_VEC_STATIC \
  -DSQLITE_EXTRA_INIT=core_init \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_ENABLE_JSON1 \
  -DSQLITE_THREADSAFE=1 \
  -DSQLITE_DQS=0 \
  $SIMD_FLAGS \
  "$BUILD_DIR/sqlite3.c" \
  "$BUILD_DIR/sqlite-vec.c" \
  "$BUILD_DIR/vec_init.c" \
  -lm \
  -o "$OUT_LIB"

echo "[build-sqlite] Built: $OUT_LIB ($(du -h "$OUT_LIB" | cut -f1))"

# --- Verify ---
echo "[build-sqlite] Verifying symbols..."
case "$OS" in
  Darwin)
    if ! nm -gU "$OUT_LIB" | grep -q sqlite3_vec_init; then
      echo "[build-sqlite] ERROR: sqlite3_vec_init not found in $OUT_LIB" >&2
      exit 1
    fi
    echo "[build-sqlite] sqlite3_vec_init found"
    ;;
  Linux)
    if ! nm -D "$OUT_LIB" | grep -q sqlite3_vec_init; then
      echo "[build-sqlite] ERROR: sqlite3_vec_init not found in $OUT_LIB" >&2
      exit 1
    fi
    echo "[build-sqlite] sqlite3_vec_init found"
    ;;
esac

echo "[build-sqlite] Done."
