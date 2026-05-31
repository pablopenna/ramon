/// <reference lib="webworker" />
// The emulation Web Worker. Loads the engines, builds the harness against the
// selected ArchProfile, and translates the message protocol into harness calls.
// All the real work lives in EmulatorHarness (proven headlessly in
// scripts/headless-proof.ts); this file is just the browser transport.
//
// Architecture selection: Keystone (WASM) is arch-independent and loaded once;
// each Unicorn asm.js build is single-arch, so 'select-arch' (re)loads the
// matching Unicorn engine and rebuilds the harness against that arch's profile.

import { loadKeystone, loadUnicorn } from '../engine/load.worker.ts';
import { EmulatorHarness } from '../emulator/harness.ts';
import { getArch, DEFAULT_ARCH_ID } from '../arch/registry.ts';
import type { KeystoneModule } from '../engine/keystone.ts';
import type { WorkerRequest, WorkerResponse } from '../emulator/protocol.ts';

let ksModule: KeystoneModule | null = null;
let harness: EmulatorHarness | null = null;
let currentArchId = '';

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

/** (Re)initialise the harness for an architecture: load Keystone once, (re)load
 *  the arch's Unicorn engine, and rebuild the harness against its profile. */
async function selectArch(id: string): Promise<void> {
  const desc = getArch(id);
  if (!ksModule) ksModule = await loadKeystone();
  const uc = await loadUnicorn(desc.unicornFile);
  const profile = desc.createProfile(uc);
  if (harness) harness.dispose();
  harness = new EmulatorHarness(ksModule, uc, profile);
  currentArchId = id;
}

async function boot(): Promise<void> {
  await selectArch(DEFAULT_ARCH_ID);
  post({ type: 'ready', archId: currentArchId });
}

let ready = boot().catch((err) => {
  post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
});

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  await ready;
  const req = ev.data;
  try {
    if (req.type === 'select-arch') {
      // Re-init engines/harness for the new arch, then report ready (no program).
      ready = selectArch(req.id);
      await ready;
      post({ type: 'ready', archId: currentArchId });
      return;
    }

    if (!harness) {
      post({ type: 'error', error: 'Emulator engines failed to initialise.' });
      return;
    }

    switch (req.type) {
      case 'load': {
        const r = harness.load(req.source);
        if (r.ok) post({ type: 'loaded', bytes: r.bytes, count: r.count, snapshot: r.snapshot });
        else
          post({
            type: 'assemble-error',
            error: r.error,
            errno: r.errno,
            line: r.line,
            lineText: r.lineText,
            hint: r.hint,
          });
        break;
      }
      case 'step':
        post({ type: 'state', snapshot: harness.step() });
        break;
      case 'run':
        post({ type: 'state', snapshot: harness.run() });
        break;
      case 'reset': {
        const snap = harness.restart();
        if (snap) post({ type: 'state', snapshot: snap });
        else post({ type: 'state', snapshot: harness.snapshot() });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
