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

/** Where the vendored engines are served from (public/vendor -> <base>/vendor).
 *  BASE_URL is inlined at build time and always ends in a slash; it is not always
 *  '/' (GitHub Pages serves the app under /<repo>/), so never hardcode the root. */
const VENDOR_BASE = `${import.meta.env.BASE_URL}vendor`;

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

/** Load the (architecture-independent) Keystone WASM module once. */
export async function loadKeystone(): Promise<KeystoneModule> {
  await loadGlobalScript(`${VENDOR_BASE}/keystone-core.js`);
  const g = self as unknown as { MKeystone?: KeystoneFactory };
  if (!g.MKeystone) throw new Error('Keystone failed to load (global `MKeystone` missing)');
  // Point Emscripten at the .wasm next to the glue.
  return g.MKeystone({ locateFile: (file: string) => `${VENDOR_BASE}/${file}` });
}

/** Load a specific (single-arch) Unicorn asm.js build; returns its `uc` namespace.
 *  Each AlexAltea build reassigns the global `uc`, so switching architecture is a
 *  matter of loading the matching file and rebuilding the harness against it. */
export async function loadUnicorn(file: string): Promise<UnicornNamespace> {
  await loadGlobalScript(`${VENDOR_BASE}/${file}`);
  const g = self as unknown as { uc?: UnicornNamespace };
  if (!g.uc) throw new Error(`Unicorn failed to load (global \`uc\` missing) from ${file}`);
  return g.uc;
}

/** Convenience: load the default (ARM64) pair. */
export async function loadEngines(): Promise<LoadedEngines> {
  const uc = await loadUnicorn('unicorn-aarch64.min.js');
  const ks = await loadKeystone();
  return { ks, uc };
}
