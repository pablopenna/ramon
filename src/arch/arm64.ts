// The one concrete ArchProfile. Built as a factory because the Unicorn register
// ids / arch / mode / prot constants come from the loaded `uc` namespace.

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

// Keystone constants (ccall path has no JS namespace): ARM64, little-endian.
const KS_ARCH_ARM64 = 2;
const KS_MODE_LE = 0;

// ARM64 Linux syscall numbers we implement.
const SYS_WRITE = 64;
const SYS_EXIT = 93;
const SYS_EXIT_GROUP = 94; // libc often uses this; treat like exit.

// Flat memory map. 64 KB per region, page-aligned, non-overlapping.
// Documented in the README. PROT_ALL everywhere: a teaching sandbox shouldn't
// trip learners on W^X subtleties.
const CODE_BASE = 0x10000;
const DATA_BASE = 0x20000;
const STACK_BASE = 0x30000;
const REGION_SIZE = 0x10000;
const STACK_TOP = STACK_BASE + REGION_SIZE; // initial SP (grows down)

export function createArm64Profile(uc: UnicornNamespace): ArchProfile {
  const memoryMap: MemoryMap = (() => {
    const code = { name: 'code', base: CODE_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    const data = { name: 'data', base: DATA_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    const stack = { name: 'stack', base: STACK_BASE, size: REGION_SIZE, prot: uc.PROT_ALL };
    return { code, data, stack, stackPointerInit: STACK_TOP, regions: [code, data, stack] };
  })();

  // x0..x30, then sp and pc.
  const registers: RegisterSpec[] = [];
  for (let i = 0; i <= 30; i++) {
    registers.push({ name: `x${i}`, regId: uc[`ARM64_REG_X${i}`] });
  }
  registers.push({ name: 'sp', regId: uc.ARM64_REG_SP });
  registers.push({ name: 'pc', regId: uc.ARM64_REG_PC });

  const SP_ID = uc.ARM64_REG_SP;
  const X8_ID = uc.ARM64_REG_X8;
  const argIds = [
    uc.ARM64_REG_X0,
    uc.ARM64_REG_X1,
    uc.ARM64_REG_X2,
    uc.ARM64_REG_X3,
    uc.ARM64_REG_X4,
    uc.ARM64_REG_X5,
  ];

  return {
    id: 'arm64',
    displayName: 'ARM64 (AArch64)',
    keystone: { arch: KS_ARCH_ARM64, mode: KS_MODE_LE },
    unicorn: { arch: uc.ARCH_ARM64, mode: uc.MODE_ARM },
    memoryMap,
    wordBytes: 8,
    registers,
    pcRegId: uc.ARM64_REG_PC,
    flags: {
      name: 'NZCV',
      regId: uc.ARM64_REG_NZCV,
      // ARM64 NZCV: bit31=N, 30=Z, 29=C, 28=V.
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
      // ARM64 Linux ABI: number in x8, args in x0..x5.
      const number = ctx.readReg(X8_ID);
      const args = argIds.map((id) => ctx.readReg(id));
      const name = number === SYS_WRITE ? 'write' : number === SYS_EXIT || number === SYS_EXIT_GROUP ? 'exit' : undefined;
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

    instructionLength: 4,

    buildSourceMap(source: string, totalBytes: number): SourceMap {
      return buildFixedWidthSourceMap(source, 4, totalBytes);
    },

    initRegisters(cpu: UnicornInstance): void {
      cpu.reg_write_i64(SP_ID, memoryMap.stackPointerInit);
    },
  };
}
