# Project state & next steps

_Last updated: 2026-05-31. **Phase 2 is COMPLETE.** Read this before starting Phase 3 (Blockly)._

> **ARM32 / multi-arch selector — investigated 2026-05-31, blocked on engines.**
> See [ARM32 (AArch32) — blocked on engine backends](#arm32-aarch32--blocked-on-engine-backends) below before attempting it.

## Where we are

**Phase 2 is DONE — core + UI, verified in a real browser.** The `ArchProfile`
seam + Web Worker harness are proven headlessly (`npm run proof`) AND now driven
by a working browser UI. `npx tsc --noEmit` and `npm run build` are both clean.

What works today:
- Assemble ARM64 text → machine code (Keystone WASM), with clean inline errors.
- Load into a flat Unicorn memory map, `run` (to exit/end/cap) and `step` (one
  instruction; PC advances 4 bytes).
- `svc` syscalls: `write` (#64) → console, `exit` (#93/#94) → halt; unknown → reported.
- PC → source line mapping, surfaced as a live current-line highlight in the editor.
- Snapshots: registers (exact 64-bit BigInt), NZCV flags, pc, current line, a
  `data` memory window, console text, halted/exitCode/stopReason/diagnostics.
- **Browser UI** (`index.html` + `src/main.ts`): CodeMirror 6 editor, Assemble/
  Run/Step/Reset toolbar, register panel (hex, changed-register highlight), NZCV
  flags, cumulative console, diagnostics, inline assemble errors, current-line
  highlight, and a 5 s main-thread wall-clock guard that terminates + respawns a
  hung worker. Verified in Chrome (dev + production preview) via Playwright:
  assemble → Run prints `Hi\n` / exit 0, Step advances the highlight with
  registers updating, bad mnemonic shows the inline error, Reset restarts.

### Worker loading gotcha (resolved — don't re-break this)
Vite **always spawns module workers in dev** (`worker.format: 'iife'` only steers
the production build), and module workers can't call `importScripts`. So
`load.worker.ts` now fetches each vendored engine script and runs it via
**indirect `eval`** (global scope) instead — works in both module (dev) and
classic (prod) workers. The worker is imported in `main.ts` via the `?worker`
suffix (`import EmulatorWorker from './worker/emulator.worker.ts?worker'`); the
`new URL(..., import.meta.url)` form is broken in dev for this case (serves an
unbundled classic worker with bare ESM imports).

### The proof
`npm run proof` assembles a "Hi\n" write+exit program, runs it (expects console
`Hi\n`, exit 0), single-steps it printing the highlighted line each step, and
checks the assemble-error path. This drives the SAME `EmulatorHarness` the browser
worker uses.

## Map of the code

| File | Role |
|------|------|
| `src/engine/keystone.ts` | typed Keystone wrapper: `assemble(text, base)` → bytes \| error |
| `src/engine/unicorn.ts` | TS surface for the asm.js `uc` namespace + `readRegExact()` |
| `src/engine/load.node.ts` / `load.worker.ts` | engine loaders (Node vs browser fetch+indirect-eval) |
| `src/arch/ArchProfile.ts` | **the seam** — interface every arch implements |
| `src/arch/arm64.ts` | `createArm64Profile(uc)` — the only concrete profile |
| `src/emulator/sourceMap.ts` | fixed-width PC↔line map |
| `src/emulator/harness.ts` | **`EmulatorHarness`** — assemble/run/step/reset/snapshot |
| `src/emulator/protocol.ts` | worker `WorkerRequest`/`WorkerResponse` + `Snapshot` |
| `src/worker/emulator.worker.ts` | browser worker = thin protocol transport over the harness |
| `index.html` + `src/main.ts` | **Phase 2 UI** — toolbar, panels, worker plumbing, wall-clock guard |
| `src/ui/editor.ts` | CodeMirror 6 wrapper + current-line highlight |
| `src/style.css` | UI styling |
| `scripts/headless-proof.ts` | the Node proof (`npm run proof`) |
| `public/vendor/*` | the vendored engines, served as static assets |

Design rationale lives in `README.md` (Architecture section) and `CLAUDE.md`.

## Decisions already made (don't re-litigate)

1. **Engines are injected into the harness**, not imported by it — that's why the
   core is provable under Node. Keep it that way.
2. **Instruction-count cap (200k) is the only in-engine run guard.** This asm.js
   Unicorn throws on a nonzero `emu_start` µs timeout (`pthread_sigmask` missing),
   so we pass `timeout=0`. Real wall-clock protection = main thread terminating a
   hung worker — **now implemented** in `main.ts` (`RUN_WALLCLOCK_MS` = 5 s:
   terminate + respawn + surface a timeout status).
3. **Memory map:** code `0x10000` / data `0x20000` / stack `0x30000`, 64 KB each,
   SP=`0x40000`, all `PROT_ALL`.
4. **Register values are exact `bigint`** (read via `reg_read(id,8)` bytes, since
   `reg_read_i64` is lossy/sign-extended). `Snapshot.registers[].value` is a BigInt.
   `pc` stays a `number` (addresses are tiny) for offset arithmetic.
5. **Syscall split:** profile `decodeSyscall` → `{number,args}`, `executeSyscall`
   → a side-effect-free *action*; the harness performs the I/O.

## Phase 2 UI — DONE

The acceptance criterion is met: type an ARM64 program, click **Run** → console
output + final registers; click **Step** → current-line highlight advances with
registers updating each instruction. Built without Blockly (that's Phase 3).
Delivered: CodeMirror editor (`src/ui/editor.ts`), Assemble/Run/Step/Reset toolbar,
register panel (hex + changed-register highlight), NZCV flags, cumulative console,
diagnostics, inline assemble errors, current-line highlight, and the wall-clock
guard. The editor seeds with the proof's `Hi\n` write+exit program.

### How to run / re-verify
- `npm run dev` → open the printed URL. Default program: Assemble → Run prints
  `Hi\n`; Reset then Step to watch the highlight advance.
- `npm run build` (tsc + vite) and `npm run proof` both pass.
- Browser-tested in Chrome via Playwright (dev + `npm run preview`).

### Notes for whoever touches this next
- BigInt is structured-cloneable, so register values cross the worker boundary fine.
- `snapshot.line` points at the *next* instruction (debugger semantics); `null`
  after `end-of-code`. Editing the source marks the program stale → re-Assemble.
- Memory window (`snapshot.memory`, the `data` region) is captured but **not yet
  rendered** — a memory panel is an easy future add.
- Don't revert the worker loading approach (see the gotcha box above).

## ARM32 (AArch32) — blocked on engine backends

Adding an ARM32 mode + an architecture chooser was attempted on 2026-05-31. The
**app-side seam is ready**, but the work is **blocked**: both vendored engines are
**AArch64-only builds** and reject `ARM` at open time.

| Engine | Result | How verified |
|--------|--------|--------------|
| Keystone (WASM) | no ARM backend | `ks_arch_supported(KS_ARCH_ARM=1)` → `0`; `ks_open(ARM)` → rc 2 (`KS_ERR_ARCH`). Built with `LLVM_TARGETS_TO_BUILD="AArch64"` (see `scripts/build-keystone-wasm.sh`). |
| Unicorn (asm.js) | no ARM backend | `uc_open(ARCH_ARM)` → `UC_ERR_ARCH`. The file is `unicorn-aarch64.min.js`. |

**Gotcha that wastes time:** the `ARCH_ARM` / `ARM_REG_*` constants *are* present in
both JS namespaces — they're enum values from the headers and say nothing about which
backends were compiled in. Don't trust the constants; the engines reject `ARM` at
`*_open`.

**To actually unblock ARM32, BOTH binaries must be re-vendored with the ARM backend:**
- **Keystone** — rerun `scripts/build-keystone-wasm.sh` with
  `LLVM_TARGETS_TO_BUILD="AArch64;ARM"` (needs emsdk under `.build/emsdk` + network +
  a long LLVM build; `emcc` is not currently on PATH and `.build/` is absent).
- **Unicorn** — the hard one. Per the README "Unicorn 2 → WASM wall", Unicorn 2 can't
  be compiled to WASM at all, so we're pinned to AlexAltea's Unicorn **1.x** asm.js.
  A **multi-arch** (ARM+AArch64) build of that is required — re-sourcing or rebuilding
  the old asm.js toolchain, which may not be feasible.

**Seam prep already landed (engine-agnostic, safe, ARM64 unchanged):** the 64-bit
register-width assumption was generalized so a 32-bit profile drops in cleanly:
- `readRegExact(cpu, regId, sizeBytes = 8)` — width is now a parameter.
- `ArchProfile.wordBytes` and `Snapshot.wordBytes` (8 = AArch64, 4 = AArch32); the
  harness reads registers at `profile.wordBytes` and the snapshot carries it for the
  UI to pad hex correctly. `Arm64Profile` sets `wordBytes: 8`. `npm run proof` + `tsc`
  stay green.

**When the engines are ready,** the remaining work is purely additive: an
`Arm32Profile` (KS_ARCH_ARM + KS_MODE_ARM; Unicorn `ARCH_ARM`/`MODE_ARM`; regs
r0–r12/sp/lr/pc + CPSR NZCV at bits 31–28; EABI syscalls — number in `r7`, args
`r0`–`r6`, `write`=4 / `exit`=1 / `exit_group`=248; `wordBytes: 4`; fixed-width
4-byte source map), a small arch registry, a `select-arch` worker message, and a
`<select>` in the toolbar. None of that touches the worker/protocol/harness contract.

## NEXT STEPS — Phase 3: Blockly visual editor

Per `CLAUDE.md`: block definitions + a block-tree → assembly-text generator, with
active-block highlighting that **reuses the Phase 2 line mapping** (`snapshot.line`).
Blocks are authoritative in visual mode; text→blocks parsing is the hard direction —
defer full bidirectional sync (treat text mode as authoritative-when-active first).
Everything still converges on the one assembly-text string the harness already
consumes, so the worker/protocol/harness layer should not need to change.

## Later (Phase 3+)
- Blockly visual editor (block-tree → assembly text), reusing this line mapping.
- Second `ArchProfile` (x86) — the seam is ready; variable-length needs its own
  `buildSourceMap`/`instructionLength` strategy.
- Richer syscalls (read/open), PWA packaging, larger memory snapshots/scrubbing.
- Known limitation: multi-instruction pseudo-ops desync the fixed-width source map.
