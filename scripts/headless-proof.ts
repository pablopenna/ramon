// Headless proof of the Phase-2 core: drive the REAL EmulatorHarness + Arm64Profile
// (the same code the browser worker uses) under Node — assemble a program that
// writes a string via svc #64 and exits via svc #93, then run it and single-step
// it. No browser, no UI. Run: `npm run proof`.

import { loadEngines } from '../src/engine/load.node.ts';
import { createArm64Profile } from '../src/arch/arm64.ts';
import { EmulatorHarness } from '../src/emulator/harness.ts';

// Build "Hi\n" (0x48 'H', 0x69 'i', 0x0a '\n') on the stack, write 3 bytes to
// stdout, then exit(0). Uses only instructions + the stack — no data directives,
// so it doesn't depend on assembler directive support.
const PROGRAM = [
  'mov  x9, #0x6948', // x9 = 0x6948  ('i'<<8 | 'H')
  'movk x9, #0x000a, lsl #16', // x9 = 0x000a6948  ('\n'<<16 | 'i'<<8 | 'H')
  'str  x9, [sp, #-16]!', // push word onto the stack
  'mov  x0, #1', // fd = stdout
  'mov  x1, sp', // buf = sp
  'mov  x2, #3', // len = 3
  'mov  x8, #64', // syscall: write
  'svc  #0',
  'mov  x0, #0', // exit code 0
  'mov  x8, #93', // syscall: exit
  'svc  #0',
].join('\n');

function fail(msg: string): never {
  console.error('\nFAIL:', msg);
  process.exit(1);
}

async function main() {
  const { ks, uc } = await loadEngines();
  const profile = createArm64Profile(uc);
  const harness = new EmulatorHarness(ks, uc, profile);

  // --- assemble + load ---
  const loaded = harness.load(PROGRAM);
  if (!loaded.ok) fail(`assemble error: ${loaded.error}`);
  console.log(`Assembled: ${loaded.bytes} bytes, ${loaded.count} instructions.`);

  // --- RUN to completion ---
  const ran = harness.run();
  console.log(`Run stopReason=${ran.stopReason} halted=${ran.halted} exitCode=${ran.exitCode}`);
  console.log(`Console output: ${JSON.stringify(ran.console)}`);
  const x0 = ran.registers.find((r) => r.name === 'x0')?.value;
  console.log(`x0=${x0}  pc=0x${ran.pc.toString(16)}  flags=${JSON.stringify(ran.flags)}`);

  const runOk = ran.stopReason === 'exit' && ran.halted && ran.exitCode === 0 && ran.console === 'Hi\n' && x0 === 0n;
  if (!runOk) fail(`unexpected run result (console=${JSON.stringify(ran.console)})`);

  // --- STEP through, watching the current line + a register advance ---
  harness.restart();
  console.log('\nSingle-stepping:');
  const lines = PROGRAM.split('\n');
  let steps = 0;
  let sawX9 = false;
  for (let i = 0; i < 20; i++) {
    const snap = harness.step();
    steps++;
    const lineText = snap.line !== null ? lines[snap.line].trim() : '(no line)';
    const x9 = snap.registers.find((r) => r.name === 'x9')?.value ?? 0n;
    if (x9 === 0x000a6948n) sawX9 = true;
    console.log(
      `  step ${String(steps).padStart(2)}: pc=0x${snap.pc.toString(16)} line=${snap.line} "${lineText}" x9=0x${x9.toString(16)}`,
    );
    if (snap.halted) break;
  }

  const stepHalted = harness.snapshot().halted;
  const stepOk = stepHalted && sawX9 && harness.snapshot().console === 'Hi\n';
  if (!stepOk) fail(`stepping did not reach a clean halt (sawX9=${sawX9}, halted=${stepHalted})`);

  // --- assemble error path ---
  const bad = harness.load('this_is_not_an_instruction x0');
  if (bad.ok) fail('expected an assemble error for a bad mnemonic');
  console.log(`\nAssemble-error path OK: "${bad.error}" (errno=${bad.errno})`);

  // --- assemble error gets pinned to the right line, even past a forward branch ---
  const BAD_PROGRAM = ['  b   done', '  mvo  x0, #1', 'done:', '  mov x8, #93', '  svc #0'].join('\n');
  const located = harness.load(BAD_PROGRAM);
  if (located.ok) fail('expected an assemble error for the bad mnemonic on line 2');
  console.log(`Located error: line=${located.line} text="${located.lineText}" hint="${located.hint}"`);
  if (located.line !== 1) fail(`expected the failure pinned to line index 1, got ${located.line}`);
  if (located.lineText !== 'mvo  x0, #1') fail(`unexpected lineText: ${JSON.stringify(located.lineText)}`);

  // --- out-of-range immediate WITH a trailing comment must still be pinned ---
  // (Keystone assembles "bad-instr // comment" to 0 bytes + OK, which would
  // hide the error unless the probe strips the comment first.)
  const OOR = ['mov  x9, #0x69481   // too big for one mov', 'mov x8, #93', 'svc #0'].join('\n');
  const oor = harness.load(OOR);
  if (oor.ok) fail('expected an assemble error for an out-of-range immediate');
  if (oor.line !== 0) fail(`out-of-range immediate not pinned to line 0 (got ${oor.line})`);
  console.log(`Out-of-range immediate pinned: line=${oor.line} hint="${oor.hint}"`);

  harness.dispose();
  console.log('\nPASS: assembled, ran (console "Hi\\n", exit 0), single-stepped with line mapping, and reported an assemble error.');
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
