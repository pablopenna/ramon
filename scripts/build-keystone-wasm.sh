#!/bin/bash
# Build Keystone -> true WebAssembly (AArch64 backend only), MODULARIZE factory
# named `MKeystone`, matching the runtime methods the wrapper uses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.build/emsdk/emsdk_env.sh" >/dev/null 2>&1

SRC="$ROOT/.build/keystone"
BUILD="$SRC/build-wasm"
mkdir -p "$BUILD"
cd "$BUILD"

# Configure: static lib only, just the AArch64 LLVM backend to keep size down.
emcmake cmake \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DBUILD_LIBS_ONLY=ON \
  -DLLVM_TARGETS_TO_BUILD="AArch64" \
  -DKEYSTONE_BUILD_STATIC_RUNTIME=OFF \
  -G "Unix Makefiles" "$SRC"

emmake make -j"$(nproc)" keystone

LIB="$(find "$BUILD" -name 'libkeystone.a' | head -1)"
echo "libkeystone.a: $LIB"

OUT="$ROOT/vendor-wasm"
mkdir -p "$OUT"
emcc -Oz "$LIB" \
  -s MODULARIZE=1 -s EXPORT_NAME=MKeystone -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,node \
  -s "EXPORTED_FUNCTIONS=['_ks_open','_ks_asm','_ks_free','_ks_close','_ks_option','_ks_strerror','_ks_version','_ks_errno','_ks_arch_supported','_malloc','_free']" \
  -s "EXPORTED_RUNTIME_METHODS=['ccall','getValue','setValue','stringToUTF8','UTF8ToString','writeArrayToMemory']" \
  -o "$OUT/keystone-core.js"

echo "=== built ==="
ls -la "$OUT"/keystone-core.*
