// Engine loader for Node (headless proof / CI). Mirrors the proven approach from
// verify.js / verify-wasm.js: the Unicorn asm.js build is eval'd so its top-level
// `var uc` attaches to the global; Keystone's WASM factory is require()d.
// Browser loading lives in load.worker.ts instead.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import type { KeystoneFactory, KeystoneModule } from './keystone.ts';
import type { UnicornNamespace } from './unicorn.ts';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// src/engine -> repo root
const root = resolve(here, '..', '..');

export interface LoadedEngines {
  ks: KeystoneModule;
  uc: UnicornNamespace;
}

/** Load the (architecture-independent) Keystone WASM module once. */
export async function loadKeystone(): Promise<KeystoneModule> {
  // Emscripten's env detection needs `require` visible as a global to pick its
  // NODE branch (otherwise SHELL mode references an undefined `print`).
  (globalThis as { require?: unknown }).require = require;
  const MKeystone = require(resolve(root, 'vendor-wasm', 'keystone-core.js')) as KeystoneFactory;
  return MKeystone();
}

/** Load a specific (single-arch) Unicorn asm.js build; returns its `uc` namespace. */
export async function loadUnicorn(file: string): Promise<UnicornNamespace> {
  (globalThis as { require?: unknown }).require = require;
  const unicornSrc = readFileSync(resolve(root, 'vendor', file), 'utf8');
  vm.runInThisContext(unicornSrc, { filename: file });
  const uc = (globalThis as unknown as { uc?: UnicornNamespace }).uc;
  if (!uc) throw new Error(`Unicorn failed to load (global \`uc\` missing) from ${file}`);
  return uc;
}

/** Convenience: load the default (ARM64) pair. */
export async function loadEngines(): Promise<LoadedEngines> {
  const uc = await loadUnicorn('unicorn-aarch64.min.js');
  const ks = await loadKeystone();
  return { ks, uc };
}
