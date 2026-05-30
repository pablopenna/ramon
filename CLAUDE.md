# CLAUDE.md

Project context for Claude Code. Read this before making structural decisions.

## What this project is

A browser-based **ARM64 (AArch64) assembly learning environment**. Users write
assembly two ways — by dragging visual blocks or by editing text — then **assemble
and run it entirely client-side via emulation**. There is no backend and no native
code execution. It ships as a static site / installable PWA so it runs in the browser
on Android, desktop, and iOS.

The core loop: write assembly → assemble to machine code → load into an emulated CPU →
run or single-step → watch registers, memory, and console output update live.

## Why web + emulation (do not re-litigate this)

This started as a native Android app idea and was deliberately moved to the web. The
reasoning is settled:

- **Native Android can't easily run generated binaries.** Since Android 10 (API 29),
  apps can't `execve()` binaries from their writable data directory (W^X). The only
  native workaround is bundling executables in the APK as `.so` files — and even then,
  *output* binaries the user compiles still can't be run.
- **The NDK no longer ships GNU `as`/`ld`.** GNU binutils was removed; the modern
  tools are Clang's integrated assembler and `lld`. So "a layer over `as`/`ld`" was
  never going to be literal.
- **We chose in-process emulation instead of native execution.** Once you emulate, the
  app was never running ARM64 natively anyway — so moving to the browser (WASM) costs
  nothing on the execution side and gains true cross-platform portability and a far
  better drag-and-drop editor story.

If a change seems to require native execution, the answer is almost certainly "emulate
it" or "handle it in the syscall layer," not "go native."

## Locked tech stack

- **Build:** Vite + TypeScript.
- **Assembler:** Keystone Engine, compiled to WASM. Turns assembly text into
  machine-code bytes. (Note: Keystone uses **LLVM assembly syntax**, not GNU `as`
  syntax — relevant for both the text editor and the block-to-text generator.)
- **Emulator:** Unicorn Engine, compiled to WASM. Loads bytes into a flat memory map
  and emulates the CPU.
- **Visual editor:** Blockly (custom instruction/operand blocks).
- **Text editor:** CodeMirror 6.
- **Execution:** runs in a Web Worker, guarded by an instruction-count cap and a
  wall-clock timeout.
- **Distribution:** static site, installable as a PWA (manifest + service worker).
  No app store required. Capacitor/Tauri wrappers are a later option if needed.

## Architecture / data flow

```
Blockly blocks  ──┐
                  ├─► assembly text (single source of truth)
text editor    ──┘            │
                              ▼
                      Keystone (WASM)  ──► machine-code bytes
                              │
                              ▼
              loaded at a fixed base address in
                      Unicorn (WASM) flat memory map
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
        UC_HOOK_CODE (per-instr)   UC_HOOK_INTR (svc)
        step + register/memory     tiny syscall layer
        readback                   ──► console output
                   │
                   ▼
        readback drives the "highlight active block/line" in the editor
```

- Both editing modes converge on **one assembly-text string** — the single source of
  truth. Only one assembler/emulator pipeline ever exists.
- Blocks are the authoritative representation in visual mode; **text → blocks parsing
  is the hard direction** — defer full bidirectional sync. Early on, treat text mode as
  authoritative-when-active and regenerate/parse later.
- **No linker step.** Keystone emits raw bytes; you place them at a fixed base address
  in a flat memory map. Linking only matters with multiple sections/symbols, which a
  teaching sandbox doesn't need.

## The ArchProfile seam (most important design decision)

Everything architecture-specific must live behind a single `ArchProfile` interface so
that adding x86 later is "write a new profile," not "rewrite the app." Only **ARM64**
is implemented now (`Arm64Profile`), but the seam exists from the start. The rest of
the app (worker harness, run/step loop, UI panels, source-of-truth plumbing) talks
**only** to the interface.

A profile bundles:
- Keystone arch/mode and Unicorn arch/mode constants.
- The memory map (code base address, stack region, data region).
- The registers to display and the Unicorn register IDs used to read them.
- A syscall decoder: given register state at an interrupt, return `{number, args}` and
  dispatch.
- An instruction-length / PC-to-source strategy.

## Memory map & syscall ABI (ARM64)

- **Flat layout:** code at a fixed base (e.g. `0x10000`), plus a stack region and an
  optional data region. Document the exact addresses in the README.
- **Syscalls** are handled via `UC_HOOK_INTR` on the `svc` instruction, driven by the
  profile. ARM64 Linux convention: syscall number in `x8`, args in `x0`–`x5`.
  Implement at least:
  - `write` (#64): read the buffer from emulated memory, append to the console panel.
  - `exit` (#93): stop the emulator.
  - Unknown syscalls: report cleanly, never crash.

## PC → source mapping

Build a map from assembled byte offset back to source line, using the offsets Keystone
reports. After each step, the worker reports the current source line so the UI can
highlight it. AArch64's fixed 4-byte instructions make this arithmetic clean — but keep
it behind the profile so variable-length architectures (x86) work later.

## Key constraints & gotchas

- **Infinite loops are expected.** Always guard `uc_emu_start` with an instruction-count
  cap *and* a timeout. On hitting the cap, stop and report — never hang the worker.
- **WASM uses the interpreter, not a JIT.** Unicorn is QEMU/TCG-based; the browser
  sandbox won't allow runtime native codegen, so the WASM build runs in interpreter
  (TCI) mode. Slower than native, but irrelevant for small teaching snippets. Don't try
  to "fix" performance with JIT tricks.
- **WASM sourcing is the project's main dependency risk** (validated in Phase 1). The
  prebuilt `unicorn.js` is Unicorn 1.x and may be stale/awkward in a modern bundler;
  `keystone.js` exists too. Fallback is building from source with Emscripten. Keystone
  is pure computation (emits bytes), so it ports cleanly; Unicorn is the harder one.
- **Build multi-architecture if x86 is a goal.** An ARM64-only Unicorn build is smaller,
  but if you want x86 later, include both backends. Mitigate size with lazy loading.
- **Keystone is LLVM-syntax** and effectively frozen at 0.9.2 — fine for ARM64, but
  don't assume GNU `as` directives/syntax work.

## Roadmap / phases

- **Phase 1 — DONE.** Toolchain validation spike: a minimal page that loads Keystone +
  Unicorn as WASM, assembles `mov x0, #42` / `svc #0`, runs it, reads `x0` back. This
  proved the round-trip and the WASM-loading approach. **Reuse that loading approach —
  don't reinvent it or swap libraries.**
- **Phase 2 — current.** Real app skeleton (text mode only, no Blockly): typed
  Keystone/Unicorn wrappers, the `ArchProfile` interface + `Arm64Profile`, the Web
  Worker emulation harness, flat memory map, syscall layer, PC→source mapping, and a
  minimal UI (CodeMirror editor; Assemble/Run/Step/Reset; register panel with x0–x30,
  sp, pc, decoded NZCV; console panel; current-line highlight on step).
- **Phase 3 — next.** Blockly visual editor: block definitions, block-tree → assembly-
  text generator, and active-block highlighting that reuses the Phase 2 line mapping.
- **Later.** Second `ArchProfile` (x86), richer syscalls, PWA packaging/offline,
  optional native wrappers.

## Working conventions

- `git init`; commit in small, logical increments with clear messages.
- Keep the assembler/emulator wrappers **framework-agnostic** so the UI can evolve
  independently.
- Keep the README current: architecture, the `ArchProfile` interface, the memory map,
  the ARM64 syscall ABI, and how to build/run.
- For decisions with real tradeoffs (worker message protocol, memory-snapshot scope,
  editor integration), state your choice and reasoning briefly, then proceed — don't
  block on small things.
- **Pause at design checkpoints.** Before wiring full UI in Phase 2, confirm the
  `ArchProfile` + worker harness can assemble-and-run a program headlessly. The two
  seams that are expensive to retrofit are the `ArchProfile` interface and the worker
  message protocol — get those right before polishing anything visual.
