#!/usr/bin/env bash
# Builds src/stretch.wasm from native/ in a pinned emscripten image and writes its SHA-256.
#   scripts/build-wasm.sh          build and update src/stretch.wasm(.sha256)
#   scripts/build-wasm.sh --check  build into a temp dir and compare with the committed hash
set -euo pipefail

# emscripten/emsdk 6.0.10, multi-arch manifest (same compiler on arm64 and x64 hosts).
IMAGE="emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65"

here="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$here/src"
check=0
if [[ "${1:-}" == "--check" ]]; then
  check=1
  # Inside the package: Docker on macOS (Colima) only mounts folders under $HOME.
  out_dir="$here/.build-check"
  rm -rf "$out_dir" && mkdir -p "$out_dir"
  trap 'rm -rf "$out_dir"' EXIT
fi

docker run --rm \
  -v "$here/native:/src/native:ro" \
  -v "$out_dir:/out" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "$IMAGE" \
  em++ /src/native/wrapper.cpp -o /out/stretch.wasm \
    -I /src/native/vendor/signalsmith-stretch \
    -I /src/native/vendor/signalsmith-linear/include \
    -std=c++14 -O3 -msimd128 -fno-exceptions -fno-rtti \
    -ffile-prefix-map=/src=. \
    -Wall -Wextra -Wno-unused-parameter \
    --no-entry -sSTANDALONE_WASM=1 -sFILESYSTEM=0 \
    -sINITIAL_MEMORY=4mb -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=256mb \
    -sABORTING_MALLOC=0 -sSTACK_SIZE=256kb \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_br_create,_br_destroy,_br_input,_br_output,_br_block_samples,_br_interval_samples,_br_input_latency,_br_output_latency,_br_set_transpose,_br_set_formant,_br_reset,_br_seek,_br_process,_br_flush

hash="$(shasum -a 256 "$out_dir/stretch.wasm" | cut -d' ' -f1)"
if [[ $check == 1 ]]; then
  want="$(cut -d' ' -f1 "$here/src/stretch.wasm.sha256")"
  if [[ "$hash" != "$want" ]]; then
    echo "stretch.wasm differs: built $hash, committed $want" >&2
    exit 1
  fi
  echo "stretch.wasm matches $hash"
else
  echo "$hash  stretch.wasm" > "$here/src/stretch.wasm.sha256"
  echo "built src/stretch.wasm ($(wc -c < "$here/src/stretch.wasm") bytes, $hash)"
fi
