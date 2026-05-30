/// <reference lib="webworker" />
// Engine loader for the browser Web Worker. The vendored engines are plain
// (non-module) scripts that publish globals (`uc`, `MKeystone`). We can't use
// importScripts: it's classic-worker-only, and Vite ALWAYS spawns module
// workers in dev (worker.format only steers the production build). So we fetch
// each script's source and indirect-eval it in the worker's global scope —
// equivalent to importScripts, but works in both classic and module workers.
// Node loading lives in load.node.ts instead.

import type { KeystoneFactory, KeystoneModule } from './keystone.ts';
import type { UnicornNamespace } from './unicorn.ts';

export interface LoadedEngines {
  ks: KeystoneModule;
  uc: UnicornNamespace;
}

/** Where the vendored engines are served from (public/vendor -> /vendor). */
const VENDOR_BASE = '/vendor';

/** Calling eval through a binding other than the name `eval` is *indirect*
 *  eval: it runs in global scope, so the script's top-level `var`/global
 *  assignments land on the worker's globalThis — the same effect importScripts
 *  has, but available in module workers too. */
const globalEval: (code: string) => void = eval;

async function loadGlobalScript(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  globalEval(await res.text());
}

export async function loadEngines(): Promise<LoadedEngines> {
  // Unicorn asm.js -> global `uc`; Keystone WASM glue -> global factory `MKeystone`.
  await loadGlobalScript(`${VENDOR_BASE}/unicorn-aarch64.min.js`);
  await loadGlobalScript(`${VENDOR_BASE}/keystone-core.js`);

  const g = self as unknown as { uc?: UnicornNamespace; MKeystone?: KeystoneFactory };
  if (!g.uc) throw new Error('Unicorn failed to load (global `uc` missing)');
  if (!g.MKeystone) throw new Error('Keystone failed to load (global `MKeystone` missing)');

  // Point Emscripten at the .wasm next to the glue.
  const ks = await g.MKeystone({ locateFile: (file: string) => `${VENDOR_BASE}/${file}` });
  return { ks, uc: g.uc };
}
