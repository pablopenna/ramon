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
  /** i64 register read/write use plain JS numbers (NOT BigInt) in this build.
   *  Note reg_read_i64 sign-extends to a JS number and loses precision above
   *  2^53 — use reg_read(regId, 8) + readRegExact() for exact 64-bit values. */
  reg_read_i64(regId: number): number;
  reg_write_i64(regId: number, value: number): void;
  /** Generic read: reg_read(regId, sizeBytes) returns the raw little-endian bytes. */
  reg_read(regId: number, size: number): Uint8Array;
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
  ARCH_ARM: number;
  MODE_ARM: number;
  MODE_LITTLE_ENDIAN: number;

  PROT_NONE: number;
  PROT_READ: number;
  PROT_WRITE: number;
  PROT_EXEC: number;
  PROT_ALL: number;

  HOOK_INTR: number;
  HOOK_CODE: number;

  // Register ids (a subset; the build exposes the full ARM64_REG_* / ARM_REG_* sets).
  [key: `ARM64_REG_${string}`]: number;
  [key: `ARM_REG_${string}`]: number;
}

/**
 * Read a register as an exact unsigned integer (BigInt), avoiding the precision
 * loss of reg_read_i64. reg_read(regId, sizeBytes) returns that many
 * little-endian bytes; we recombine them into a BigInt. `sizeBytes` must match
 * the architecture's register width (8 for AArch64, 4 for AArch32) — reading
 * more bytes than the register holds yields garbage high bytes in this build.
 */
export function readRegExact(cpu: UnicornInstance, regId: number, sizeBytes = 8): bigint {
  const bytes = cpu.reg_read(regId, sizeBytes);
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return v;
}
