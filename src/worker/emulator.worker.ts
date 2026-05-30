/// <reference lib="webworker" />
// The emulation Web Worker. Loads the engines, builds the harness against the
// ArchProfile, and translates the message protocol into harness calls. All the
// real work lives in EmulatorHarness (proven headlessly in scripts/headless-proof.ts);
// this file is just the browser transport.

import { loadEngines } from '../engine/load.worker.ts';
import { createArm64Profile } from '../arch/arm64.ts';
import { EmulatorHarness } from '../emulator/harness.ts';
import type { WorkerRequest, WorkerResponse } from '../emulator/protocol.ts';

let harness: EmulatorHarness | null = null;

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function boot(): Promise<void> {
  const { ks, uc } = await loadEngines();
  const profile = createArm64Profile(uc);
  harness = new EmulatorHarness(ks, uc, profile);
  post({ type: 'ready' });
}

const ready = boot().catch((err) => {
  post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
});

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  await ready;
  if (!harness) {
    post({ type: 'error', error: 'Emulator engines failed to initialise.' });
    return;
  }
  const req = ev.data;
  try {
    switch (req.type) {
      case 'load': {
        const r = harness.load(req.source);
        if (r.ok) post({ type: 'loaded', bytes: r.bytes, count: r.count, snapshot: r.snapshot });
        else post({ type: 'assemble-error', error: r.error, errno: r.errno });
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
