# cpu-emulator — Keystone + Unicorn AArch64 round-trip (in-browser)

Toolchain validation: assemble and run ARM64 (AArch64) assembly entirely
client-side — no backend, no native execution. Keystone assembles the text to
machine code; Unicorn loads those bytes and emulates the CPU.

The program being proven:

```asm
mov x0, #42
svc #0
```

Success criterion: the page shows `x0 == 42` and confirms the `svc` interrupt
hook fired.

## WASM builds used (Step 1 — see status below)

This first cut uses the prebuilt **AlexAltea** browser ports:

| Engine   | File                          | Source                                                        | Size  |
|----------|-------------------------------|---------------------------------------------------------------|-------|
| Keystone | `vendor/keystone.min.js`      | https://github.com/AlexAltea/keystone.js (`dist/`)            | 12 MB |
| Unicorn  | `vendor/unicorn-aarch64.min.js` | https://github.com/AlexAltea/unicorn.js (`dist/`, ARM64-only) | 3 MB  |

Each file is self-contained: the Emscripten module **plus** the JS wrapper and
constants are bundled, exposing globals `ks` and `uc` synchronously after the
`<script>` tag. The Unicorn build is the **ARM64-only** variant to keep size down.

> ⚠️ **Format caveat:** these prebuilt files are **asm.js**, not WebAssembly
> (Emscripten `EMSCRIPTEN_START_ASM` modules, no `.wasm`). They run in any
> browser as plain JS and fully prove the Keystone→Unicorn round-trip, but they
> do **not** satisfy the literal "via WebAssembly" goal. No prebuilt *true-WASM*
> build of either engine exists on npm or in these repos — true WASM requires
> compiling from source with Emscripten. Per the plan, Step 1 (this asm.js
> baseline) is committed first as a proven, de-risked round-trip; Step 2 attempts
> a true-WASM Emscripten build to swap in.

## Run the browser demo

Open `index.html`. Because the engines are pure JS (no `.wasm` fetch), even
`file://` works, but a static server is the clean path:

```bash
# any one of these, from the repo root:
python3 -m http.server 8000      # then open http://localhost:8000/
npx serve .
```

You should see the assembled bytes (`40 05 80 d2 01 00 00 d4`), the hook firing,
`X0 = 42`, and a green **PASS**.

## Headless proof (no browser)

`verify.js` loads the *exact same* vendored builds under Node and runs the
identical round-trip, so the toolchain is provable in CI:

```bash
node verify.js
```

Expected output:

```
Keystone: assembled 2 insns, 8 bytes: 40 05 80 d2 01 00 00 d4
Unicorn: svc hook fired = true (intno=2)
Unicorn: X0 = 42

PASS: x0 == 42 and svc hook fired.
```

## API notes (AlexAltea wrappers)

- `new ks.Keystone(ks.ARCH_ARM64, ks.MODE_LITTLE_ENDIAN)` → `.asm(text, addr)`
  returns `{ mc: Uint8Array, failed: bool, count }`.
- `new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM)` →
  `mem_map / mem_write / hook_add(uc.HOOK_INTR, cb, data, begin, end) /
  emu_start(begin, until, timeout, count) / reg_read_i64(uc.ARM64_REG_X0)`.
- The `HOOK_INTR` callback receives `(handle, intno, user_data)`; `handle` is the
  Unicorn instance, so `handle.emu_stop()` halts emulation on `svc`.
- `reg_read_i64` returns a plain JS number by default (low 32 bits) — fine for 42.
