// Minimal TypeScript surface for the vendored AlexAltea Unicorn 1.x asm.js build.
// We only type the methods/constants the harness actually uses; the real object
// has many more. Loaded at runtime (importScripts in the worker, vm eval in Node)
// — these are types only, not an implementation.

/** Callback for UC_HOOK_INTR. `handle` is the Unicorn instance (so `handle.emu_stop()` works). */
export type IntrHook = (handle: UnicornInstance, intno: number, userData: unknown) => void;

export interface UnicornInstance {
  mem_map(base: number, size: number, prot: number): void;
  mem_write(addr: number, bytes: ArrayLike<number>): void;
  /** Returns the bytes as a Uint8Array. */
  mem_read(addr: number, len: number): Uint8Array;
  /** i64 register read/write use plain JS numbers (NOT BigInt) in this build. */
  reg_read_i64(regId: number): number;
  reg_write_i64(regId: number, value: number): void;
  hook_add(type: number, callback: IntrHook, userData: unknown, begin: number, end: number): number;
  hook_del(handle: number): void;
  /** emu_start(begin, until, timeoutMicros, instructionCount). count/timeout 0 = unlimited. */
  emu_start(begin: number, until: number, timeout: number, count: number): void;
  emu_stop(): void;
  close(): void;
}

export interface UnicornInstanceCtor {
  new (arch: number, mode: number): UnicornInstance;
}

/** The global `uc` namespace exposed by the vendored script. */
export interface UnicornNamespace {
  Unicorn: UnicornInstanceCtor;

  ARCH_ARM64: number;
  MODE_ARM: number;

  PROT_NONE: number;
  PROT_READ: number;
  PROT_WRITE: number;
  PROT_EXEC: number;
  PROT_ALL: number;

  HOOK_INTR: number;
  HOOK_CODE: number;

  // Register ids (a subset; the build exposes the full ARM64_REG_* set).
  [key: `ARM64_REG_${string}`]: number;
}
