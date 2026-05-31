// The architecture seam. EVERYTHING architecture-specific lives behind this
// interface so adding x86 later is "write a new profile", not "rewrite the app".
// Only Arm64Profile implements it today; the harness/worker/UI talk ONLY to this.

import type { UnicornInstance } from '../engine/unicorn.ts';

export interface MemoryRegion {
  name: string;
  base: number;
  size: number;
  prot: number; // Unicorn PROT_* flags
}

export interface MemoryMap {
  code: MemoryRegion;
  data: MemoryRegion;
  stack: MemoryRegion;
  /** Initial stack pointer (typically the top of the stack region). */
  stackPointerInit: number;
  /** All regions to mem_map, in order. */
  regions: MemoryRegion[];
}

export interface RegisterSpec {
  /** Display name, e.g. "x0", "sp", "pc". */
  name: string;
  /** Unicorn register id to read it with. */
  regId: number;
}

/** A read-only view of CPU + memory state at the moment of an interrupt. */
export interface SyscallContext {
  readReg(regId: number): number;
  readMem(addr: number, len: number): Uint8Array;
}

/** Decoded syscall: number + raw integer arguments. */
export interface DecodedSyscall {
  number: number;
  args: number[];
  /** Human-readable name if known, e.g. "write". */
  name?: string;
}

/**
 * What the harness should DO in response to a syscall. The profile stays
 * side-effect-free: it decides the action, the harness performs it. This keeps
 * the profile pure/testable and the I/O surface in one place.
 */
export type SyscallAction =
  | { kind: 'output'; text: string } // append to console, continue
  | { kind: 'exit'; code: number } // stop the emulator
  | { kind: 'none' } // recognised, no effect, continue
  | { kind: 'unknown'; number: number }; // report cleanly, continue

/** Maps between assembled byte offsets (relative to code base) and source lines. */
export interface SourceMap {
  /** 0-based source line for a byte offset, or null if none. */
  offsetToLine(offset: number): number | null;
  /** Byte offset for a 0-based source line, or null if that line emits no code. */
  lineToOffset(line: number): number | null;
}

export interface ArchProfile {
  /** Stable id, e.g. "arm64". */
  readonly id: string;
  readonly displayName: string;

  /** Keystone arch/mode constants for this architecture. */
  readonly keystone: { arch: number; mode: number };
  /** Unicorn arch/mode constants for this architecture. */
  readonly unicorn: { arch: number; mode: number };

  readonly memoryMap: MemoryMap;

  /** Native register width in bytes (8 for AArch64, 4 for AArch32). Drives the
   *  exact register readback and the display formatting. */
  readonly wordBytes: number;

  /** Registers to display, in order. */
  readonly registers: RegisterSpec[];
  /** Unicorn register id of the program counter (set to code base on load, read each step). */
  readonly pcRegId: number;
  /** Flags register (e.g. NZCV) + a decoder into named bits, if the arch has one. */
  readonly flags?: {
    name: string;
    regId: number;
    decode(value: number): Record<string, 0 | 1>;
  };

  /** Decode the syscall number + args from register/memory state at an interrupt. */
  decodeSyscall(intno: number, ctx: SyscallContext): DecodedSyscall;
  /** Decide what to do about a decoded syscall (no side effects). */
  executeSyscall(call: DecodedSyscall, ctx: SyscallContext): SyscallAction;

  /**
   * Fixed instruction length in bytes, or null for variable-length archs.
   * ARM64 = 4; kept behind the profile so x86 (variable) works later.
   */
  readonly instructionLength: number | null;

  /** Build the offset<->line map for a given source, knowing the assembled size.
   *  `assembleLine` measures one line's assembled byte length (null on failure),
   *  letting the map account for lines that emit != one fixed-width instruction
   *  (e.g. `ldr =imm` literal-pool loads). */
  buildSourceMap(
    source: string,
    totalBytes: number,
    assembleLine: (text: string) => number | null,
  ): SourceMap;

  /** Set up initial register state on a fresh CPU (e.g. SP). PC is set by the harness. */
  initRegisters(cpu: UnicornInstance): void;
}
