// Headless proof for ARM32 (AArch32). Mirrors scripts/headless-proof.ts but for
// the arm32 profile: assemble + run the sample "Hi\n" write/exit program, expect
// console "Hi\n" and exit 0; single-step a few instructions; and check the
// assemble-error path. Drives the SAME EmulatorHarness the browser worker uses.
//
//   npm run proof:arm32

import { loadKeystone, loadUnicorn } from '../src/engine/load.node.ts';
import { EmulatorHarness } from '../src/emulator/harness.ts';
import { getArch } from '../src/arch/registry.ts';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const ks = await loadKeystone();
  const desc = getArch('arm32');
  const uc = await loadUnicorn(desc.unicornFile);

  // The constants exist in the namespace even on an arch-less build, so prove the
  // backend is really compiled in by opening a CPU (throws UC_ERR_ARCH otherwise).
  const probe = new uc.Unicorn(uc.ARCH_ARM, uc.MODE_ARM);
  probe.close();

  const profile = desc.createProfile(uc);
  const harness = new EmulatorHarness(ks, uc, profile);

  const src = desc.defaultProgram;
  const loaded = harness.load(src);
  assert(loaded.ok, `assemble arm32 sample: ${loaded.ok ? '' : loaded.error}`);
  if (loaded.ok) console.log(`assembled ${loaded.bytes} bytes, ${loaded.count} instruction(s)`);

  const snap = harness.run();
  console.log('console :', JSON.stringify(snap.console));
  console.log('exitCode:', snap.exitCode, '| stopReason:', snap.stopReason);
  assert(snap.console === 'Hi\n', `expected console "Hi\\n", got ${JSON.stringify(snap.console)}`);
  assert(snap.exitCode === 0, `expected exit 0, got ${snap.exitCode}`);

  // Single-step: PC->line highlight should advance.
  const r2 = harness.load(src);
  assert(r2.ok, 'reload for stepping');
  for (let i = 0; i < 3; i++) {
    const s = harness.step();
    console.log(`step ${i}: line=${s.line} pc=0x${s.pc.toString(16)}`);
  }

  // Assemble-error path: a bogus mnemonic must fail cleanly (not throw).
  const bad = harness.load('not_a_real_instruction r0, r1');
  assert(!bad.ok, 'bogus instruction should fail to assemble');
  if (!bad.ok) console.log('assemble-error ok:', bad.error, bad.line !== undefined ? `(line ${bad.line})` : '');

  console.log('\nARM32 proof PASS ✅');
  harness.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
