# RAMON
R - Real
A - Actual
M - Meow
O - CPU
N - Emulator for teaching

## Description
cpu-emulator — Keystone + Unicorn AArch64 round-trip (in-browser)

Toolchain validation: assemble and run ARM64 (AArch64) assembly entirely
client-side — no backend, no native execution. Keystone assembles the text to
machine code; Unicorn loads those bytes and emulates the CPU.

Program being proven:

```asm
mov x0, #42
svc #0
```

Success criterion: the page shows `x0 == 42` and confirms the `svc` interrupt
hook (`UC_HOOK_INTR`) fired.

---

## TL;DR — what works

| Round-trip | Assembler | Emulator | Page | Headless proof | Status |
|------------|-----------|----------|------|----------------|--------|
| **asm.js** (zero-build) | Keystone asm.js | Unicorn asm.js | `index.html` | `node verify.js` | ✅ works |
| **WASM-assemble** (hybrid) | **Keystone true WASM** (built from source) | Unicorn asm.js | `index-wasm.html` | `node verify-wasm.js` | ✅ works |

Both print the assembled bytes `40 05 80 d2 01 00 00 d4`, fire the `svc` hook
(intno=2), and read **X0 = 42**.

**A fully-WASM round-trip is not achievable:** Keystone compiles to real
WebAssembly, but **Unicorn 2 cannot be built to WASM** (details below), so the
emulator half stays asm.js. No library was substituted — both halves are still
Keystone and Unicorn.

---

## Which WASM builds were used

### asm.js (prebuilt, AlexAltea)

| Engine   | File                            | Source                                              | Size  |
|----------|---------------------------------|-----------------------------------------------------|-------|
| Keystone | `vendor/keystone.min.js`        | github.com/AlexAltea/keystone.js (`dist/`)          | 12 MB |
| Unicorn  | `vendor/unicorn-aarch64.min.js` | github.com/AlexAltea/unicorn.js (`dist/`, ARM64-only) | 3 MB  |

These are self-contained **asm.js** Emscripten modules (no `.wasm`; the markers
`EMSCRIPTEN_START_ASM` / `use asm` are present, zero `WebAssembly` references).
Each bundles the engine + JS wrapper + constants and exposes the globals `ks` /
`uc` synchronously after the `<script>` tag. The Unicorn file is the ARM64-only
variant to keep size down. They are not WebAssembly, but they prove the
round-trip runs fully client-side with no backend.

### Keystone → true WASM (built here, from source)

| File | What | Size |
|------|------|------|
| `vendor-wasm/keystone-core.wasm` | real `WebAssembly (wasm) binary module` | 832 KB |
| `vendor-wasm/keystone-core.js`   | Emscripten glue (MODULARIZE factory `MKeystone`) | 63 KB |

Built with Emscripten 5.x from `keystone-engine/keystone`, **AArch64 LLVM
backend only**, `-Oz`, libs-only. ~14× smaller than the asm.js Keystone.
Rebuild with:

```bash
bash scripts/build-keystone-wasm.sh   # needs .build/emsdk (see below)
```

---

## The Unicorn 2 → WASM wall (why the emulator stays asm.js)

Attempting an ARM64-only Emscripten build fails immediately:

```
$ emcmake cmake -DUNICORN_ARCH="aarch64" ...
CMake Error at CMakeLists.txt:282 (message):
  Unknown host compiler: .../emscripten/emcc.
```

This is not a superficial check. Unicorn 2 is QEMU/TCG-based: TCG needs a
**native host codegen backend** selected by `UNICORN_TARGET_ARCH` and pulled in
from `qemu/tcg/<host>` (line ~473). The tree ships only real host backends
(`qemu/tcg/{arm,aarch64,i386,mips,ppc,riscv,s390,sparc,...}`) — there is **no
wasm backend and no TCG interpreter (TCI)**. Forcing past line 282 only reaches
that deeper, fundamental gap. This is exactly why the only in-browser Unicorn in
existence is AlexAltea's **Unicorn 1.x**, which is the asm.js build used above.

Per the task instruction ("if you hit a wall on either engine, stop and report
rather than substituting a different library"), the emulator remains Unicorn
(asm.js); no alternative emulator was swapped in.

---

## Run it locally

**asm.js round-trip** — `index.html`. Pure JS (no `.wasm` fetch), so even
`file://` works; a static server is cleaner:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

**WASM-assemble round-trip** — `index-wasm.html`. Must be served over HTTP so the
`.wasm` can be fetched (`file://` will not work):

```bash
python3 -m http.server 8000   # then open http://localhost:8000/index-wasm.html
```

Each page shows the assembled bytes, the hook firing, `X0 = 42`, and a green
**PASS**.

## Headless proofs (no browser)

The same vendored builds, run under Node, so the toolchain is provable in CI.
Run all three with `npm test`, or individually:

```bash
node verify.js                 # asm.js Keystone + asm.js Unicorn
node verify-keystone-wasm.js   # true-WASM Keystone only (assembles correctly)
node verify-wasm.js            # true-WASM Keystone + asm.js Unicorn round-trip
```

Expected (each):

```
... 8 bytes: 40 05 80 d2 01 00 00 d4
... svc hook fired = true (intno=2)
... X0 = 42
PASS
```

> Node note: the asm.js builds are loaded via `vm.runInThisContext` with
> `globalThis.require = require` so Emscripten's env-detection picks its NODE
> branch instead of SHELL mode (which references an undefined global `print`).
> The browser never hits this.

---

## Build prerequisites (only to rebuild the WASM)

Emscripten is vendored under `.build/emsdk` (gitignored). To recreate:

```bash
mkdir -p .build && cd .build
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
cd ../.. && git clone --depth 1 https://github.com/keystone-engine/keystone.git .build/keystone
bash scripts/build-keystone-wasm.sh
```

## API notes (AlexAltea asm.js wrappers, used by `index.html`)

- `new ks.Keystone(ks.ARCH_ARM64, ks.MODE_LITTLE_ENDIAN).asm(text, addr)` →
  `{ mc: Uint8Array, failed: bool, count }`.
- `new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM)` →
  `mem_map / mem_write / hook_add(uc.HOOK_INTR, cb, data, begin, end) /
  emu_start(begin, until, timeout, count) / reg_read_i64(uc.ARM64_REG_X0)`.
- The `HOOK_INTR` callback gets `(handle, intno, user_data)`; `handle` is the
  Unicorn instance, so `handle.emu_stop()` halts on `svc`.

In the WASM Keystone path (`index-wasm.html` / `verify-wasm.js`) the engine is
driven directly via `ccall`; note `ks_asm`'s `uint64_t address` is a single i64
param (WASM_BIGINT), so it is passed as a `BigInt`.
