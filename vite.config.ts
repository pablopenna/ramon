import { defineConfig } from 'vite';

// The vendored engines (public/vendor/*) are loaded at runtime via importScripts
// inside the emulator Web Worker, so the worker must be emitted as a *classic*
// (iife) worker — module workers cannot call importScripts. See src/worker/.
export default defineConfig({
  worker: {
    format: 'iife',
  },
  build: {
    target: 'es2022',
  },
});
