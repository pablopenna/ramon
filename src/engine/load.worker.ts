/// <reference lib="webworker" />
// Engine loader for the browser Web Worker. The vendored engines are plain
// (non-module) scripts that publish globals, so we pull them in with
// importScripts — which requires a CLASSIC worker (see vite.config.ts
// worker.format = 'iife'). Node loading lives in load.node.ts instead.

import type { KeystoneFactory, KeystoneModule } from './keystone.ts';
import type { UnicornNamespace } from './unicorn.ts';

export interface LoadedEngines {
  ks: KeystoneModule;
  uc: UnicornNamespace;
}

/** Where the vendored engines are served from (public/vendor -> /vendor). */
const VENDOR_BASE = '/vendor';

export async function loadEngines(): Promise<LoadedEngines> {
  // Unicorn asm.js -> global `uc`; Keystone WASM glue -> global factory `MKeystone`.
  importScripts(`${VENDOR_BASE}/unicorn-aarch64.min.js`);
  importScripts(`${VENDOR_BASE}/keystone-core.js`);

  const g = self as unknown as { uc?: UnicornNamespace; MKeystone?: KeystoneFactory };
  if (!g.uc) throw new Error('Unicorn failed to load (global `uc` missing)');
  if (!g.MKeystone) throw new Error('Keystone failed to load (global `MKeystone` missing)');

  // Point Emscripten at the .wasm next to the glue.
  const ks = await g.MKeystone({ locateFile: (file: string) => `${VENDOR_BASE}/${file}` });
  return { ks, uc: g.uc };
}
