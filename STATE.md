# Project state & next steps

_Last updated: 2026-05-31. **Phase 2 is COMPLETE.** Read this before starting Phase 3 (Blockly)._

> **ARM32 / multi-arch selector — DONE 2026-05-31.** Both engines were re-vendored
> with the ARM backend and ARM32 now runs end-to-end alongside ARM64 (toolbar arch
> selector). See [ARM32 (AArch32) — shipped](#arm32-aarch32--shipped) below.

## Where we are

**Phase 2 is DONE — core + UI, verified in a real browser.** The `ArchProfile`
seam + Web Worker harness are proven headlessly (`npm run proof`) AND now driven
by a working browser UI. `npx tsc --noEmit` and `npm run build` are both clean.

What works today:
- **Two architectures, selectable from the toolbar `Arch` dropdown: ARM64 (AArch64)
  and ARM32 (AArch32).** Switching reloads the matching Unicorn engine and rebuilds
  the harness; see [ARM32 (AArch32) — shipped](#arm32-aarch32--shipped).
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
| `src/ui/panels.ts` | sidebar layout — collapse/reorder/resize + `localStorage` (`ramon.layout.v1`) |
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

The three sidebar panels are collapsible (click the header), reorderable (grip
drag or ▲/▼) and resizable (drag the splitter between two expanded panels;
arrow keys work too, double-click evens the pair). `↺` in the sidebar bar
restores the defaults. Layout persists in `localStorage['ramon.layout.v1']`;
`src/ui/panels.ts` discovers panels from `[data-panel]` + `data-default-weight`
in the markup, so adding a panel needs no code change.

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

## ARM32 (AArch32) — shipped

ARM32 (A32/ARM mode) runs end-to-end alongside ARM64, selectable from the toolbar
`Arch` dropdown. Verified headlessly via `npm run proof:arm32` (assemble + run the
`Hi\n` write/exit sample, single-step, assemble-error path) and through `npm run build`.

**What unblocked it — both engines re-vendored with the ARM backend:**
- **Keystone** — rebuilt with `LLVM_TARGETS_TO_BUILD="AArch64;ARM"` (see
  `scripts/build-keystone-wasm.sh`). The WASM grew ~832 KB → ~1.4 MB. One module
  serves both arches (Keystone is arch-independent at the JS level; the profile
  passes `KS_ARCH_ARM` + `KS_MODE_ARM`).
- **Unicorn** — vendored a separate single-arch ARM build, `unicorn-arm.min.js`,
  next to `unicorn-aarch64.min.js`. Each AlexAltea build is single-arch and reassigns
  the global `uc`, so switching arch means loading the matching file and rebuilding
  the harness against it.

**Gotcha that still applies:** the `ARCH_ARM` / `ARM_REG_*` constants are present in
the namespace regardless of which backends were compiled in — they say nothing about
support. The headless proof opens a CPU (`new uc.Unicorn(ARCH_ARM, MODE_ARM)`) to
prove the backend is really there, since `*_open` is what rejects a missing backend.

**How it's wired (all additive — the worker/protocol/harness contract was untouched):**
- `src/arch/registry.ts` — the `ARCHES` list: id, displayName, `unicornFile`,
  `createProfile`, and a per-arch `defaultProgram`. Adding an arch = one entry here
  + a vendored engine + a profile.
- `src/arch/arm32.ts` — `Arm32Profile`: `KS_ARCH_ARM` + `KS_MODE_ARM`; Unicorn
  `ARCH_ARM`/`MODE_ARM`; regs r0–r12/sp/lr/pc + CPSR NZCV at bits 31–28; EABI
  syscalls (number in `r7`, args `r0`–`r6`; `write`=4 / `exit`=1 / `exit_group`=248);
  `wordBytes: 4`; fixed-width 4-byte source map.
- `select-arch` worker message (`src/worker/emulator.worker.ts`): loads Keystone
  once, (re)loads the arch's Unicorn engine, rebuilds the harness. Toolbar `<select>`
  in `index.html`; `switchArch` in `src/main.ts` wipes per-program UI state and seeds
  the new arch's sample. Hex padding honors `snapshot.wordBytes` (32-bit regs show as
  8 digits).

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
