# Project state & next steps

_Last updated: 2026-05-30. Read this before resuming Phase 2._

## Where we are

**Phase 2 core is DONE and proven headlessly.** The `ArchProfile` seam + Web Worker
emulation harness are built and verified end-to-end under Node (no browser) via
`npm run proof`. `npx tsc --noEmit` is clean.

What works today:
- Assemble ARM64 text → machine code (Keystone WASM), with clean inline errors.
- Load into a flat Unicorn memory map, `run` (to exit/end/cap) and `step` (one
  instruction; PC advances 4 bytes).
- `svc` syscalls: `write` (#64) → console, `exit` (#93/#94) → halt; unknown → reported.
- PC → source line mapping (for the upcoming line highlight).
- Snapshots: registers (exact 64-bit BigInt), NZCV flags, pc, current line, a
  `data` memory window, console text, halted/exitCode/stopReason/diagnostics.
- Worker message protocol wired (`emulator.worker.ts`), but **no UI consumes it yet.**

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
| `src/engine/load.node.ts` / `load.worker.ts` | engine loaders (Node vs browser importScripts) |
| `src/arch/ArchProfile.ts` | **the seam** — interface every arch implements |
| `src/arch/arm64.ts` | `createArm64Profile(uc)` — the only concrete profile |
| `src/emulator/sourceMap.ts` | fixed-width PC↔line map |
| `src/emulator/harness.ts` | **`EmulatorHarness`** — assemble/run/step/reset/snapshot |
| `src/emulator/protocol.ts` | worker `WorkerRequest`/`WorkerResponse` + `Snapshot` |
| `src/worker/emulator.worker.ts` | browser worker = thin protocol transport over the harness |
| `scripts/headless-proof.ts` | the Node proof (`npm run proof`) |
| `public/vendor/*` | the vendored engines, served as static assets |

Design rationale lives in `README.md` (Architecture section) and `CLAUDE.md`.

## Decisions already made (don't re-litigate)

1. **Engines are injected into the harness**, not imported by it — that's why the
   core is provable under Node. Keep it that way.
2. **Instruction-count cap (200k) is the only in-engine run guard.** This asm.js
   Unicorn throws on a nonzero `emu_start` µs timeout (`pthread_sigmask` missing),
   so we pass `timeout=0`. Real wall-clock protection = main thread terminating a
   hung worker (implement this in the UI step — see below).
3. **Memory map:** code `0x10000` / data `0x20000` / stack `0x30000`, 64 KB each,
   SP=`0x40000`, all `PROT_ALL`.
4. **Register values are exact `bigint`** (read via `reg_read(id,8)` bytes, since
   `reg_read_i64` is lossy/sign-extended). `Snapshot.registers[].value` is a BigInt.
   `pc` stays a `number` (addresses are tiny) for offset arithmetic.
5. **Syscall split:** profile `decodeSyscall` → `{number,args}`, `executeSyscall`
   → a side-effect-free *action*; the harness performs the I/O.

## NEXT STEPS — Phase 2 UI (not yet started)

The user paused here before UI. Acceptance criterion (from the brief): type a small
ARM64 program, click **Run** → see console output + final registers; click **Step**
→ watch the current line highlight advance with registers updating each instruction.

Build a minimal but functional UI (NO Blockly — that's Phase 3):

1. **`index.html` + `src/main.ts`** — Vite entry. Replace the current spike
   `index.html` (it's the Phase 1 demo; move/delete it). Lay out: editor pane,
   register panel, console panel, button row.
2. **Spawn the worker** from `main.ts`:
   `new Worker(new URL('./worker/emulator.worker.ts', import.meta.url))` (classic
   worker — `vite.config.ts` already sets `worker.format='iife'` for `importScripts`).
   Talk to it via the `protocol.ts` types. Wait for `{type:'ready'}` before enabling buttons.
3. **CodeMirror 6** editor for the source (`npm i codemirror @codemirror/state
   @codemirror/view`). Plain text is fine; no ARM grammar needed for Phase 2.
4. **Buttons:** Assemble (`load`), Run (`run`), Step (`step`), Reset (`reset`).
   - On `assemble-error`, show the message inline (gutter/banner) at/near the source.
   - Disable Run/Step while a request is in flight and after `halted`.
5. **Register panel:** render `snapshot.registers` (x0–x30, sp, pc) as hex —
   format BigInt with `'0x' + v.toString(16).padStart(16,'0')`. Show NZCV from
   `snapshot.flags`. Highlight registers that changed since the last snapshot.
6. **Console panel:** render `snapshot.console` (it's cumulative text).
7. **Current-line highlight:** use `snapshot.line` (0-based) to highlight the line
   in CodeMirror after each step/run. Note: `line` points at the *next* instruction
   to execute (standard debugger semantics); after `end-of-code` it's `null`.
8. **Wall-clock guard:** when posting `run`, start a main-thread timer (~5s); if no
   response, `worker.terminate()`, spawn a fresh worker, and surface "stopped:
   timeout". This is the wall-clock half the engine can't provide.
9. **Diagnostics:** surface `snapshot.diagnostics[]` (unknown syscall, cap hit,
   end-of-code, runtime fault) somewhere non-intrusive.

### A good first browser smoke test
Use the proof's program (writes "Hi\n", exits) as the editor's default content so
Run immediately shows output and Step demonstrates the highlight.

### Watch out for
- **Worker type must stay classic** (iife) or `importScripts` breaks.
- The vendored `.wasm` must be reachable at `/vendor/keystone-core.js` →
  `locateFile` already points there (`load.worker.ts`). Verify the dev server
  serves `public/vendor/*` (it does by default).
- BigInt is structured-cloneable, so register values cross the worker boundary fine.

## Later (Phase 3+)
- Blockly visual editor (block-tree → assembly text), reusing this line mapping.
- Second `ArchProfile` (x86) — the seam is ready; variable-length needs its own
  `buildSourceMap`/`instructionLength` strategy.
- Richer syscalls (read/open), PWA packaging, larger memory snapshots/scrubbing.
- Known limitation: multi-instruction pseudo-ops desync the fixed-width source map.
