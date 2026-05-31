// The ARM32 (AArch32, A32/ARM mode) ArchProfile. Mirrors arm64.ts: built as a
// factory because the Unicorn register ids / arch / mode / prot constants come
// from the loaded `uc` namespace (here the 32-bit ARM asm.js build).

import type { UnicornInstance, UnicornNamespace } from '../engine/unicorn.ts';
import { buildFixedWidthSourceMap } from '../emulator/sourceMap.ts';
import type {
  ArchProfile,
  DecodedSyscall,
  MemoryMap,
  RegisterSpec,
  SourceMap,
  SyscallAction,
  SyscallContext,
} from './ArchProfile.ts';

// Keystone constants (ccall path has no JS namespace): ARM, little-endian, A32.
const KS_ARCH_ARM = 1;
const KS_MODE_LE = 0;
const KS_MODE_ARM = 1; // A32 (vs KS_MODE_THUMB); little-endian = LE | ARM.

// ARM Linux EABI syscall numbers we implement.
const SYS_WRITE = 4;
const SYS_EXIT = 1;
const SYS_EXIT_GROUP = 248; // libc often uses this; treat like exit.

// Flat memory map — identical layout to arm64 (documented in the README).
// 64 KB per region, page-aligned, non-overlapping, PROT_ALL everywhere.
const CODE_BASE = 0x10000;
const DATA_BASE = 0x20000;
const STACK_BASE = 0x30000;
const REGION_SIZE = 0x10000;
const STACK_TOP = STACK_BASE + REGION_SIZE; // initial SP (grows down)

export function createArm32Profile(uc: UnicornNamespace): ArchProfile {
  const memoryMap: MemoryMap = (() => {
    const code = { name: 'code', base: CODE_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    const data = { name: 'data', base: DATA_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    const stack = { name: 'stack', base: STACK_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    return { code, data, stack, stackPointerInit: STACK_TOP, regions: [code, data, stack] };
  })();

  // r0..r12, then sp (r13), lr (r14), pc (r15).
  const registers: RegisterSpec[] = [];
  for (let i = 0; i <= 12; i++) {
    registers.push({ name: `r${i}`, regId: uc[`ARM_REG_R${i}`] });
  }
  registers.push({ name: 'sp', regId: uc.ARM_REG_SP });
  registers.push({ name: 'lr', regId: uc.ARM_REG_LR });
  registers.push({ name: 'pc', regId: uc.ARM_REG_PC });

  const SP_ID = uc.ARM_REG_SP;
  const R7_ID = uc.ARM_REG_R7;
  // EABI args live in r0..r6.
  const argIds = [
    uc.ARM_REG_R0,
    uc.ARM_REG_R1,
    uc.ARM_REG_R2,
    uc.ARM_REG_R3,
    uc.ARM_REG_R4,
    uc.ARM_REG_R5,
    uc.ARM_REG_R6,
  ];

  return {
    id: 'arm32',
    displayName: 'ARM32 (AArch32)',
    keystone: { arch: KS_ARCH_ARM, mode: KS_MODE_LE | KS_MODE_ARM },
    unicorn: { arch: uc.ARCH_ARM, mode: uc.MODE_ARM },
    memoryMap,
    wordBytes: 4,
    registers,
    pcRegId: uc.ARM_REG_PC,
    flags: {
      name: 'CPSR',
      regId: uc.ARM_REG_CPSR,
      // CPSR NZCV: bit31=N, 30=Z, 29=C, 28=V (same layout as ARM64's NZCV).
      decode(value: number): Record<string, 0 | 1> {
        return {
          N: ((value >>> 31) & 1) as 0 | 1,
          Z: ((value >>> 30) & 1) as 0 | 1,
          C: ((value >>> 29) & 1) as 0 | 1,
          V: ((value >>> 28) & 1) as 0 | 1,
        };
      },
    },

    decodeSyscall(_intno: number, ctx: SyscallContext): DecodedSyscall {
      // ARM Linux EABI: number in r7, args in r0..r6.
      const number = ctx.readReg(R7_ID);
      const args = argIds.map((id) => ctx.readReg(id));
      const name =
        number === SYS_WRITE ? 'write' : number === SYS_EXIT || number === SYS_EXIT_GROUP ? 'exit' : undefined;
      return { number, args, name };
    },

    executeSyscall(call: DecodedSyscall, ctx: SyscallContext): SyscallAction {
      switch (call.number) {
        case SYS_WRITE: {
          // write(fd, buf, count) -> read the buffer from emulated memory.
          const [, buf, count] = call.args;
          const len = Math.max(0, count | 0);
          const bytes = len > 0 ? ctx.readMem(buf, len) : new Uint8Array(0);
          const text = new TextDecoder().decode(bytes);
          return { kind: 'output', text };
        }
        case SYS_EXIT:
        case SYS_EXIT_GROUP:
          return { kind: 'exit', code: call.args[0] | 0 };
        default:
          return { kind: 'unknown', number: call.number };
      }
    },

    instructionLength: 4, // A32: fixed 4-byte instructions (Thumb is a later toggle).

    buildSourceMap(source: string, totalBytes: number): SourceMap {
      return buildFixedWidthSourceMap(source, 4, totalBytes);
    },

    initRegisters(cpu: UnicornInstance): void {
      cpu.reg_write_i64(SP_ID, memoryMap.stackPointerInit);
    },
  };
}
