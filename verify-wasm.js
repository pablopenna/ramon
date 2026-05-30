// Headless proof of the HYBRID round-trip: assemble with the from-source
// true-WASM Keystone, emulate with the asm.js Unicorn (Unicorn 2 cannot be
// built to WASM -- see README). Run: node verify-wasm.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// asm.js Unicorn needs `require` visible as a global (see verify.js).
globalThis.require = require;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, 'vendor', 'unicorn-aarch64.min.js'), 'utf8'),
  { filename: 'unicorn-aarch64.min.js' });
const uc = globalThis.uc;

const MKeystone = require('./vendor-wasm/keystone-core.js'); // true WASM factory

const KS_ARCH_ARM64 = 2, KS_MODE_LE = 0;
const PROGRAM = 'mov x0, #42\nsvc #0';
const BASE = 0x10000;

// Minimal Keystone-over-WASM assemble(): returns Uint8Array of machine code.
function ksAsm(m, program, base) {
  const hp = m._malloc(4);
  if (m.ccall('ks_open', 'number', ['number', 'number', 'pointer'],
      [KS_ARCH_ARM64, KS_MODE_LE, hp]) !== 0) throw new Error('ks_open failed');
  const handle = m.getValue(hp, '*');
  const ip = m._malloc(4), sp = m._malloc(4), cp = m._malloc(4);
  const blen = program.length + 1, bp = m._malloc(blen);
  m.stringToUTF8(program, bp, blen);
  // `address` is a single i64 param in this WASM build -> pass a BigInt.
  if (m.ccall('ks_asm', 'number',
      ['pointer', 'pointer', 'number', 'pointer', 'pointer', 'pointer'],
      [handle, bp, BigInt(base), ip, sp, cp]) !== 0) throw new Error('ks_asm failed');
  const insn = m.getValue(ip, '*'), size = m.getValue(sp, 'i32');
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = m.getValue(insn + i, 'i8') & 0xff;
  m.ccall('ks_free', 'void', ['pointer'], [insn]);
  m.ccall('ks_close', 'number', ['pointer'], [handle]);
  return out;
}

MKeystone().then((m) => {
  const code = Array.from(ksAsm(m, PROGRAM, BASE));
  console.log('Keystone(WASM): ' + code.length + ' bytes: ' +
    code.map(b => b.toString(16).padStart(2, '0')).join(' '));

  const e = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM);
  e.mem_map(BASE, 4 * 1024, uc.PROT_ALL);
  e.mem_write(BASE, code);
  let svcFired = false, intno = null;
  e.hook_add(uc.HOOK_INTR, function (h, n) { svcFired = true; intno = n; h.emu_stop(); },
    {}, BASE, BASE + code.length);
  e.emu_start(BASE, BASE + code.length, 0, 0);
  const x0 = e.reg_read_i64(uc.ARM64_REG_X0);
  e.close();

  console.log('Unicorn(asm.js): svc hook fired = ' + svcFired + ' (intno=' + intno + ')');
  console.log('Unicorn(asm.js): X0 = ' + x0);
  const ok = svcFired && x0 === 42;
  console.log(ok ? '\nPASS: WASM-assembled, emulated, x0 == 42, svc hook fired.' : '\nFAIL');
  process.exit(ok ? 0 : 1);
}).catch((e) => { console.error('FAIL:', e); process.exit(1); });
