// Environment-agnostic emulation harness. It receives already-loaded engine
// handles (Keystone module + Unicorn namespace) and an ArchProfile, and exposes
// load / step / run / reset / snapshot. The browser worker and the headless
// Node proof both drive THIS — so the core is provable without a browser.

import { Keystone } from '../engine/keystone.ts';
import type { KeystoneModule } from '../engine/keystone.ts';
import { readRegExact } from '../engine/unicorn.ts';
import type { UnicornInstance, UnicornNamespace } from '../engine/unicorn.ts';
import type { ArchProfile, SourceMap, SyscallContext } from '../arch/ArchProfile.ts';
import { isInstructionLine } from './sourceMap.ts';
import type { MemoryWindow, Snapshot, StopReason } from './protocol.ts';

/** Default execution guard. The instruction-count cap is the ONLY in-engine
 *  guard against infinite loops: this asm.js Unicorn build can't honor
 *  emu_start's µs timeout (it needs signals/threads -> pthread_sigmask, which
 *  the build lacks), so we always pass timeout=0. Wall-clock protection instead
 *  comes from the main thread, which can terminate a hung worker. */
const DEFAULT_INSTRUCTION_CAP = 200_000;
const EMU_TIMEOUT_US = 0;
/** How many bytes of each memory region to include in a snapshot. */
const MEMORY_WINDOW_BYTES = 256;

export interface LoadOk {
  ok: true;
  bytes: number;
  count: number;
  snapshot: Snapshot;
}
export interface LoadErr {
  ok: false;
  error: string;
  errno: number;
  /** 0-based source line we pinned the failure to, when we could. */
  line?: number;
  /** The trimmed text of that line, for display. */
  lineText?: string;
  /** A short, plain-language hint about this class of error. */
  hint?: string;
}
export type LoadResult = LoadOk | LoadErr;

export class EmulatorHarness {
  private readonly ks: Keystone;
  private readonly uc: UnicornNamespace;
  private readonly profile: ArchProfile;
  private readonly instructionCap: number;

  private cpu: UnicornInstance | null = null;
  private source = '';
  private codeBase = 0;
  private codeEnd = 0;
  private sourceMap: SourceMap | null = null;

  private consoleBuffer = '';
  private halted = false;
  private exitCode: number | null = null;
  private stopReason: StopReason = 'idle';
  private diagnostics: string[] = [];

  constructor(
    ksModule: KeystoneModule,
    uc: UnicornNamespace,
    profile: ArchProfile,
    opts: { instructionCap?: number } = {},
  ) {
    this.uc = uc;
    this.profile = profile;
    this.ks = new Keystone(ksModule, profile.keystone.arch, profile.keystone.mode);
    this.instructionCap = opts.instructionCap ?? DEFAULT_INSTRUCTION_CAP;
  }

  /** Assemble `source`, build a fresh CPU, and load the code. */
  load(source: string): LoadResult {
    const asm = this.ks.assemble(source, this.profile.memoryMap.code.base);
    if (!asm.ok) {
      const located = this.locateAssembleError(source);
      return {
        ok: false,
        error: asm.error,
        errno: asm.errno,
        line: located?.line,
        lineText: located?.text,
        hint: assembleHint(asm.error),
      };
    }

    this.reset(); // tear down any previous CPU + state
    this.source = source;

    const map = this.profile.memoryMap;
    const cpu = new this.uc.Unicorn(this.profile.unicorn.arch, this.profile.unicorn.mode);
    for (const region of map.regions) {
      cpu.mem_map(region.base, region.size, region.prot);
    }

    this.codeBase = map.code.base;
    this.codeEnd = map.code.base + asm.bytes.length;
    cpu.mem_write(this.codeBase, Array.from(asm.bytes));

    this.profile.initRegisters(cpu);
    cpu.reg_write_i64(this.profile.pcRegId, this.codeBase);

    this.installInterruptHook(cpu, map.code.base, map.code.base + map.code.size);

    this.cpu = cpu;
    this.sourceMap = this.profile.buildSourceMap(source, asm.bytes.length);
    this.stopReason = 'idle';

    // Sanity note if the fixed-width map likely desynced (multi-insn line, etc.).
    if (this.profile.instructionLength) {
      const expected = asm.bytes.length / this.profile.instructionLength;
      if (asm.count !== expected) {
        this.diagnostics.push(
          `Note: ${asm.count} instructions in ${asm.bytes.length} bytes; line highlighting may be approximate.`,
        );
      }
    }

    return { ok: true, bytes: asm.bytes.length, count: asm.count, snapshot: this.snapshot() };
  }

  /** Execute exactly one instruction. */
  step(): Snapshot {
    const cpu = this.requireCpu();
    if (this.halted) return this.snapshot();
    const pc = cpu.reg_read_i64(this.profile.pcRegId);
    if (pc >= this.codeEnd) {
      this.stopReason = 'end-of-code';
      this.halted = true;
      this.note('Reached end of code without an exit syscall.');
      return this.snapshot();
    }
    this.stopReason = 'step';
    try {
      cpu.emu_start(pc, this.codeEnd, 0, 1);
    } catch (err) {
      return this.handleRuntimeError(err);
    }
    if (!this.halted) {
      const newPc = cpu.reg_read_i64(this.profile.pcRegId);
      if (newPc >= this.codeEnd) {
        this.stopReason = 'end-of-code';
        this.halted = true;
        this.note('Reached end of code without an exit syscall.');
      }
    }
    return this.snapshot();
  }

  /** Run from the current PC until exit / end-of-code / cap / fault. */
  run(): Snapshot {
    const cpu = this.requireCpu();
    if (this.halted) return this.snapshot();
    const pc = cpu.reg_read_i64(this.profile.pcRegId);
    try {
      cpu.emu_start(pc, this.codeEnd, EMU_TIMEOUT_US, this.instructionCap);
    } catch (err) {
      return this.handleRuntimeError(err);
    }
    if (this.halted) return this.snapshot(); // exit syscall fired

    const newPc = cpu.reg_read_i64(this.profile.pcRegId);
    if (newPc >= this.codeEnd) {
      this.stopReason = 'end-of-code';
      this.halted = true;
      this.note('Reached end of code without an exit syscall.');
    } else {
      // Didn't halt, didn't reach end => stopped by the instruction cap.
      this.stopReason = 'cap';
      this.note(
        `Stopped after the instruction cap (${this.instructionCap}) — possible infinite loop. Still resumable.`,
      );
    }
    return this.snapshot();
  }

  /** Tear down the CPU and all per-program state. */
  reset(): void {
    if (this.cpu) {
      try {
        this.cpu.close();
      } catch {
        // ignore: closing an already-stopped CPU
      }
      this.cpu = null;
    }
    this.consoleBuffer = '';
    this.halted = false;
    this.exitCode = null;
    this.diagnostics = [];
    this.stopReason = 'idle';
  }

  /** Reload the same source from scratch (re-assemble + fresh CPU). */
  restart(): Snapshot | null {
    if (!this.source) return null;
    const r = this.load(this.source);
    return r.ok ? r.snapshot : null;
  }

  snapshot(): Snapshot {
    const cpu = this.cpu;
    const profile = this.profile;
    if (!cpu) {
      return {
        registers: [],
        wordBytes: profile.wordBytes,
        flags: null,
        flagsName: null,
        pc: 0,
        line: null,
        memory: [],
        console: this.consoleBuffer,
        halted: this.halted,
        exitCode: this.exitCode,
        stopReason: this.stopReason,
        diagnostics: [...this.diagnostics],
      };
    }

    // Exact native-width values (reg_read_i64 loses precision above 2^53, and
    // over-reading a 32-bit register would pick up garbage high bytes).
    const registers = profile.registers.map((r) => ({
      name: r.name,
      value: readRegExact(cpu, r.regId, profile.wordBytes),
    }));

    let flags: Record<string, 0 | 1> | null = null;
    let flagsName: string | null = null;
    if (profile.flags) {
      flags = profile.flags.decode(cpu.reg_read_i64(profile.flags.regId));
      flagsName = profile.flags.name;
    }

    const pc = cpu.reg_read_i64(profile.pcRegId);
    const line = this.sourceMap ? this.sourceMap.offsetToLine(pc - this.codeBase) : null;

    const memory: MemoryWindow[] = profile.memoryMap.regions
      .filter((r) => r.name === 'data')
      .map((r) => {
        const len = Math.min(MEMORY_WINDOW_BYTES, r.size);
        return { name: r.name, base: r.base, bytes: Array.from(cpu.mem_read(r.base, len)) };
      });

    return {
      registers,
      wordBytes: profile.wordBytes,
      flags,
      flagsName,
      pc,
      line,
      memory,
      console: this.consoleBuffer,
      halted: this.halted,
      exitCode: this.exitCode,
      stopReason: this.stopReason,
      diagnostics: [...this.diagnostics],
    };
  }

  dispose(): void {
    this.reset();
    this.ks.close();
  }

  // ---- internals ----

  private installInterruptHook(cpu: UnicornInstance, begin: number, end: number): void {
    const profile = this.profile;
    cpu.hook_add(
      this.uc.HOOK_INTR,
      (handle, intno) => {
        const ctx: SyscallContext = {
          readReg: (id) => handle.reg_read_i64(id),
          readMem: (addr, len) => handle.mem_read(addr, len),
        };
        const decoded = profile.decodeSyscall(intno, ctx);
        const action = profile.executeSyscall(decoded, ctx);
        switch (action.kind) {
          case 'output':
            this.consoleBuffer += action.text;
            break;
          case 'exit':
            this.halted = true;
            this.exitCode = action.code;
            this.stopReason = 'exit';
            handle.emu_stop();
            break;
          case 'unknown':
            this.note(`Unknown syscall #${action.number} (ignored).`);
            break;
          case 'none':
            break;
        }
      },
      {},
      begin,
      end,
    );
  }

  /**
   * Best-effort: pin an assembler failure to a single source line by re-probing
   * each instruction-bearing line on its own. Keystone reports a message but no
   * location, so we assemble each line in isolation and report the first that
   * fails. All label and `.equ`/`.set` definitions in the program are prepended
   * to every probe so that forward references (e.g. `b loop`, `mov x0, #CONST`)
   * still resolve and don't masquerade as the culprit. Returns null when no
   * single line fails on its own (e.g. a duplicate label or a cross-line issue),
   * in which case the caller falls back to the bare Keystone message.
   */
  private locateAssembleError(source: string): { line: number; text: string } | null {
    const lines = source.split('\n');
    const defs: string[] = [];
    for (const raw of lines) {
      const code = stripLineComment(raw);
      const label = /^\s*([A-Za-z_.$][\w.$]*)\s*:/.exec(code);
      if (label) defs.push(`${label[1]}:`);
      const equ = /^\s*\.(?:equ|set)\s+([A-Za-z_.$][\w.$]*)\s*,\s*(.+)$/.exec(code);
      if (equ) defs.push(`.equ ${equ[1]}, ${equ[2].trim()}`);
    }
    const prefix = defs.length ? defs.join('\n') + '\n' : '';
    const base = this.profile.memoryMap.code.base;

    for (let i = 0; i < lines.length; i++) {
      if (!isInstructionLine(lines[i])) continue;
      // Strip the inline comment AND any leading label: Keystone silently
      // assembles a bad instruction to 0 bytes when a trailing `//` comment is
      // present (it returns OK), which would hide the very error we're hunting.
      // Probing the bare instruction surfaces the failure. The leading label is
      // dropped so the prefix's copy of it isn't a duplicate definition.
      const instr = stripLineComment(lines[i]).replace(/^\s*[A-Za-z_.$][\w.$]*\s*:/, '');
      if (!this.ks.assemble(prefix + instr, base).ok) {
        return { line: i, text: lines[i].trim() };
      }
    }
    return null;
  }

  private handleRuntimeError(err: unknown): Snapshot {
    const message = err instanceof Error ? err.message : String(err);
    this.stopReason = 'error';
    this.halted = true;
    this.note(`Runtime fault: ${message}`);
    return this.snapshot();
  }

  private requireCpu(): UnicornInstance {
    if (!this.cpu) throw new Error('No program loaded — call load() first.');
    return this.cpu;
  }

  private note(text: string): void {
    this.diagnostics.push(text);
  }
}

/** Strip `;` and `//` line comments (matches sourceMap's classification). */
function stripLineComment(line: string): string {
  let out = line;
  for (const marker of [';', '//']) {
    const idx = out.indexOf(marker);
    if (idx !== -1) out = out.slice(0, idx);
  }
  return out;
}

/**
 * A short, plain-language nudge keyed off the Keystone error text. These are
 * the messages the ARM64 backend actually emits; the regexes are deliberately
 * loose. Returns undefined when nothing specific applies (the raw message and
 * the offending line already carry the detail).
 */
function assembleHint(error: string): string | undefined {
  const msg = error.toLowerCase();
  if (msg.includes('mnemonic') || msg.includes('instruction'))
    return 'Check the instruction spelling — Keystone uses LLVM syntax, not GNU `as` syntax.';
  if (msg.includes('operand'))
    return 'Check the operands: register names (x0–x30, sp), addressing mode (e.g. [x0, #8]), and immediate syntax (#42, #0x2a).';
  if (msg.includes('immediate') || msg.includes('range'))
    return 'The immediate is out of range for this instruction — many ops cap immediates at 12 bits; build larger constants with mov/movk.';
  if (msg.includes('symbol') || msg.includes('undefined'))
    return 'A referenced label or symbol is undefined — check for a typo or a missing `label:` definition.';
  // Keystone often reports a bare "Unknown error" for, e.g., an immediate the
  // instruction can't encode. The pinned line tells the user where; this nudges
  // them toward the usual cause.
  return 'Keystone could not encode this line. Common causes: an immediate that is out of range for the instruction (build large constants with mov + movk), or an operand form the instruction does not accept.';
}
