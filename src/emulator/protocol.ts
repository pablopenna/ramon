// Worker message protocol + the shared Snapshot shape returned after every
// run/step. Kept in its own module so the main thread, the worker, and the
// headless proof all agree on one contract.

export interface RegisterValue {
  name: string;
  /** Exact unsigned 64-bit value (read as raw bytes -> BigInt; structured-cloneable). */
  value: bigint;
}

export interface MemoryWindow {
  /** Region label, e.g. "data". */
  name: string;
  base: number;
  /** Bytes captured starting at `base` (may be a prefix of the region). */
  bytes: number[];
}

/** Why the last run/step stopped. */
export type StopReason =
  | 'exit' // exit syscall
  | 'end-of-code' // PC ran past the assembled code without an exit syscall
  | 'cap' // hit the instruction-count cap / timeout (still resumable)
  | 'step' // single step completed normally
  | 'error' // a runtime fault (bad memory access, invalid insn, …)
  | 'idle'; // nothing run yet

export interface Snapshot {
  registers: RegisterValue[];
  flags: Record<string, 0 | 1> | null;
  flagsName: string | null;
  pc: number;
  /** 0-based source line at the current PC, or null. */
  line: number | null;
  memory: MemoryWindow[];
  console: string;
  halted: boolean;
  exitCode: number | null;
  stopReason: StopReason;
  /** Non-fatal notes (unknown syscalls, end-of-code, cap hit, runtime error text). */
  diagnostics: string[];
}

// ---- main -> worker ----
export type WorkerRequest =
  | { type: 'load'; source: string }
  | { type: 'step' }
  | { type: 'run' }
  | { type: 'reset' };

// ---- worker -> main ----
export type WorkerResponse =
  | { type: 'ready' } // worker booted, engines loaded
  | { type: 'loaded'; bytes: number; count: number; snapshot: Snapshot } // assembled OK
  | { type: 'assemble-error'; error: string; errno: number }
  | { type: 'state'; snapshot: Snapshot } // after run/step/reset
  | { type: 'error'; error: string }; // worker-level failure
