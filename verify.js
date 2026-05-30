// Headless proof of the Keystone -> Unicorn round-trip, using the EXACT same
// vendored asm.js builds that index.html loads. Run: `node verify.js`.
//
// The dist files declare top-level `var ks` / `var uc`. We eval them with
// vm.runInThisContext so those declarations attach to the global object,
// mirroring how a browser <script> tag exposes them as globals.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Emscripten's env detection needs `require` visible as a global to pick its
// NODE branch; under runInThisContext it otherwise falls back to SHELL mode
// (which references an undefined global `print`). The browser never hits this.
globalThis.require = require;

function loadGlobal(file) {
  const src = fs.readFileSync(path.join(__dirname, 'vendor', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

loadGlobal('keystone.min.js');        // -> global.ks
loadGlobal('unicorn-aarch64.min.js'); // -> global.uc

const ks = globalThis.ks;
const uc = globalThis.uc;

const PROGRAM = 'mov x0, #42\nsvc #0';
const BASE = 0x10000;

// 1. Assemble with Keystone (AArch64, little-endian).
const ksCtx = new ks.Keystone(ks.ARCH_ARM64, ks.MODE_LITTLE_ENDIAN);
const out = ksCtx.asm(PROGRAM, BASE);
ksCtx.close();
if (out.failed) throw new Error('Keystone failed to assemble');
const code = Array.from(out.mc);
console.log(`Keystone: assembled ${out.count} insns, ${code.length} bytes:`,
  code.map(b => b.toString(16).padStart(2, '0')).join(' '));

// 2. Emulate with Unicorn.
const e = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM);
e.mem_map(BASE, 4 * 1024, uc.PROT_ALL);
e.mem_write(BASE, code);

// 4. Interrupt hook to catch `svc` and stop the CPU.
let svcFired = false;
let svcIntno = null;
e.hook_add(uc.HOOK_INTR, function (handle, intno /*, user_data */) {
  svcFired = true;
  svcIntno = intno;
  handle.emu_stop();
}, {}, BASE, BASE + code.length);

// 5. Run, then read X0 back.
e.emu_start(BASE, BASE + code.length, 0, 0);
const x0 = e.reg_read_i64(uc.ARM64_REG_X0);
e.close();

console.log(`Unicorn: svc hook fired = ${svcFired} (intno=${svcIntno})`);
console.log(`Unicorn: X0 = ${x0}`);

const ok = svcFired && x0 === 42;
console.log(ok ? '\nPASS: x0 == 42 and svc hook fired.' : '\nFAIL');
process.exit(ok ? 0 : 1);
