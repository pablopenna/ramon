# RAMON
**R** - Real

**A** - Actual

**M** - Meow

**O** - CPU

**N** - Emulator for teaching

## Description
cpu-emulator — Keystone + Unicorn ARM round-trip (in-browser)

A browser-based ARM assembly learning environment (ARM64/AArch64 and ARM32/AArch32,
selectable in the toolbar): write assembly, assemble it to machine code, and
run/single-step it under emulation — entirely client-side, no backend, no native
execution.

---

## Architecture (Phase 2 core)

```
source text ──► Keystone (WASM) ──► machine-code bytes
                                          │
                            loaded at the code base in
                                Unicorn (asm.js) flat memory
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
              emu_start(pc,end,0,1)  (step)      UC_HOOK_INTR on `svc`
              emu_start(pc,end,0,cap) (run)      ──► ArchProfile syscall layer
                          │                          ──► console output / exit
                          ▼
              snapshot: registers + NZCV + pc + current source line + memory
```

- **`Keystone`** (`src/engine/keystone.ts`) — typed wrapper: `assemble(text, base)`
  → bytes, or a clean error message (`ks_errno`/`ks_strerror`).
- **`EmulatorHarness`** (`src/emulator/harness.ts`) — environment-agnostic core:
  assemble → map memory → load → `run`/`step`/`reset` → `snapshot`. It receives
  already-loaded engine handles, so it runs in both the browser worker and Node.
- **Engine loaders** — `load.worker.ts` (browser, `importScripts`) and
  `load.node.ts` (Node, `vm`+`require`). Same engines, two transports.
- **Web Worker** (`src/worker/emulator.worker.ts`) — drives the harness via the
  message protocol in `src/emulator/protocol.ts`.

### The `ArchProfile` seam

Everything architecture-specific lives behind one interface
(`src/arch/ArchProfile.ts`) so adding x86 later is "write a new profile," not
"rewrite the app." Two profiles exist today — `Arm64Profile` (`src/arch/arm64.ts`)
and `Arm32Profile` (`src/arch/arm32.ts`) — listed in `src/arch/registry.ts` and
selectable from the toolbar `Arch` dropdown; the harness/worker/UI talk **only** to
the interface. A profile bundles:

- Keystone arch/mode + Unicorn arch/mode constants.
- The memory map (regions + initial SP).
- The display registers + their Unicorn register ids, and a flags decoder (NZCV).
- A syscall **decoder** (`decodeSyscall` → `{number, args}`) and a side-effect-free
  **dispatcher** (`executeSyscall` → an *action* the harness performs).
- The instruction-length / PC→source strategy.

### Memory map (ARM64)

| Region | Base      | Size   | Notes                          |
|--------|-----------|--------|--------------------------------|
| code   | `0x10000` | 64 KB  | assembled bytes loaded here    |
| data   | `0x20000` | 64 KB  | snapshotted (first 256 bytes)  |
| stack  | `0x30000` | 64 KB  | SP initialised to `0x40000` (top, grows down) |

All regions are mapped `PROT_ALL` (a teaching sandbox shouldn't trip learners on
W^X). PC starts at the code base.

### Syscall ABI (ARM64 Linux)

Handled via `UC_HOOK_INTR` on `svc`. Number in **x8**, args in **x0–x5**.

- `write` (**#64**): read `count` bytes at `buf` from emulated memory, append to
  the console (fd ignored — all output goes to the console panel).
- `exit` (**#93**) / `exit_group` (**#94**): stop the emulator with the given code.
- Unknown syscalls: reported in `diagnostics`, never crash.

### Syscall ABI (ARM32 Linux EABI)

The ARM32 profile uses the same flat memory map (regions at the same bases) and the
EABI convention: number in **r7**, args in **r0–r6**, `svc #0`. Same set:
`write` (**#4**), `exit` (**#1**) / `exit_group` (**#248**); registers are 32-bit
(`wordBytes: 4`, hex shown as 8 digits), CPSR provides NZCV at bits 31–28. The
ARM32 round-trip is verified by `npm run proof:arm32`.

### PC → source mapping

ARM64 is fixed 4-byte: the *i*-th instruction-bearing source line (blank,
comment-only, label-only and directive lines emit nothing) maps to byte offset
`i*4`. The strategy lives behind the profile so variable-length archs (x86) can
swap it. Limitation: a line that assembles to more than one instruction desyncs
the map from that point — acceptable for a teaching sandbox.

### Execution guards

Infinite loops are expected. `run` is bounded by an **instruction-count cap**
(200 000) — the only in-engine guard, because this asm.js Unicorn can't honor
`emu_start`'s µs timeout (it needs `pthread_sigmask`). Wall-clock protection
comes from the worker: the main thread can terminate a hung worker.

### Build / run

```bash
npm install
npm run dev      # Vite dev server (the app)
npm run build    # tsc typecheck + Vite production build
npm run proof    # headless Node proof: drives the REAL harness, no browser
```

`npm run proof` assembles a write+exit program, runs it (expects console `Hi\n`,
exit 0), single-steps it with line mapping, and checks the assemble-error path —
the same `EmulatorHarness` the browser uses.

`npm run dev` serves the **Phase 2 app**: a CodeMirror editor, an
Assemble/Run/Step/Reset toolbar, and live register / NZCV-flags / console /
diagnostics panels, with the current source line highlighted as you step. The
editor seeds with the `Hi\n` write+exit program, so Run prints output and Step
demonstrates the highlight immediately.

---

## Phase 1 — toolchain validation spike

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
| **WASM-assemble** (default) | **Keystone true WASM** (built from source) | Unicorn asm.js | — | `node verify-wasm.js` | ✅ works |
| **asm.js** (alternative) | Keystone asm.js | Unicorn asm.js | — | `node verify.js` | ✅ works |

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

Run the app with `npm run dev` (see [Build / run](#build--run) above). The
Keystone-WASM + asm.js-Unicorn round-trip is also provable without a browser via
the headless proofs below.

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

## API notes (AlexAltea asm.js wrappers — Unicorn, and the asm.js-Keystone alternative)

- `new ks.Keystone(ks.ARCH_ARM64, ks.MODE_LITTLE_ENDIAN).asm(text, addr)` →
  `{ mc: Uint8Array, failed: bool, count }`.
- `new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM)` →
  `mem_map / mem_write / hook_add(uc.HOOK_INTR, cb, data, begin, end) /
  emu_start(begin, until, timeout, count) / reg_read_i64(uc.ARM64_REG_X0)`.
- The `HOOK_INTR` callback gets `(handle, intno, user_data)`; `handle` is the
  Unicorn instance, so `handle.emu_stop()` halts on `svc`.

In the default WASM Keystone path (`verify-wasm.js`) the engine is
driven directly via `ccall`; note `ks_asm`'s `uint64_t address` is a single i64
param (WASM_BIGINT), so it is passed as a `BigInt`.
