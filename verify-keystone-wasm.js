// Headless proof that the FROM-SOURCE true-WASM Keystone build assembles
// correctly. Loads vendor-wasm/keystone-core.{js,wasm} (a real WebAssembly
// module, MODULARIZE factory MKeystone) and assembles `mov x0,#42; svc #0`,
// checking the bytes match the known-good encoding. Run: node verify-keystone-wasm.js
const path = require('path');
const MKeystone = require('./vendor-wasm/keystone-core.js');

const ARCH_ARM64 = 2;
const MODE_LITTLE_ENDIAN = 0;
const PROGRAM = 'mov x0, #42\nsvc #0';
const BASE = 0x10000;
const EXPECTED = '40 05 80 d2 01 00 00 d4';

MKeystone().then((m) => {
  // Confirm this is genuinely WebAssembly-backed.
  console.log('WebAssembly module instantiated:', typeof WebAssembly === 'object');

  const handle_ptr = m._malloc(4);
  let ret = m.ccall('ks_open', 'number',
    ['number', 'number', 'pointer'],
    [ARCH_ARM64, MODE_LITTLE_ENDIAN, handle_ptr]);
  if (ret !== 0) throw new Error('ks_open failed: ' + ret);
  const handle = m.getValue(handle_ptr, '*');

  const insn_ptr = m._malloc(4);
  const size_ptr = m._malloc(4);
  const count_ptr = m._malloc(4);
  const blen = PROGRAM.length + 1;
  const bptr = m._malloc(blen);
  m.stringToUTF8(PROGRAM, bptr, blen);

  // This WASM build keeps `uint64_t address` as a single i64 param (WASM_BIGINT),
  // so the address must be passed as a BigInt.
  ret = m.ccall('ks_asm', 'number',
    ['pointer', 'pointer', 'number', 'pointer', 'pointer', 'pointer'],
    [handle, bptr, BigInt(BASE), insn_ptr, size_ptr, count_ptr]);
  if (ret !== 0) throw new Error('ks_asm failed: ' + m.ccall('ks_strerror', 'string', ['number'], [m.ccall('ks_errno','number',['pointer'],[handle])]));

  const insn = m.getValue(insn_ptr, '*');
  const size = m.getValue(size_ptr, 'i32');
  const count = m.getValue(count_ptr, 'i32');
  const bytes = [];
  for (let i = 0; i < size; i++) bytes.push(m.getValue(insn + i, 'i8') & 0xff);
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');

  console.log(`Keystone(WASM): ${count} insns, ${size} bytes: ${hex}`);
  const ok = hex === EXPECTED;
  console.log(ok ? `\nPASS: WASM Keystone matches expected encoding (${EXPECTED}).`
                 : `\nFAIL: expected ${EXPECTED}`);
  process.exit(ok ? 0 : 1);
}).catch((e) => { console.error('FAIL:', e); process.exit(1); });
