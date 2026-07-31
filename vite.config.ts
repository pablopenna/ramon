import { defineConfig } from 'vite';

// The vendored engines (public/vendor/*) are loaded at runtime via importScripts
// inside the emulator Web Worker, so the worker must be emitted as a *classic*
// (iife) worker — module workers cannot call importScripts. See src/worker/.
export default defineConfig({
  // GitHub Pages serves this project under https://<user>.github.io/<repo>/, so the
  // CI build sets BASE_PATH=/<repo>/. Locally (dev, preview) it stays at the root.
  // Everything that builds a runtime URL must go through import.meta.env.BASE_URL —
  // see VENDOR_BASE in src/engine/load.worker.ts.
  base: process.env.BASE_PATH ?? '/',
  worker: {
    format: 'iife',
  },
  build: {
    target: 'es2022',
  },
});
