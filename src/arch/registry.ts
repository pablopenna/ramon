// The architecture registry: the single list of selectable architectures. Both
// the worker (to load the right Unicorn engine + build the profile) and the UI
// (to populate the arch dropdown + seed the editor) read from here. Adding an
// architecture = add a vendored engine + a profile + one entry here.

import type { ArchProfile } from './ArchProfile.ts';
import type { UnicornNamespace } from '../engine/unicorn.ts';
import { createArm64Profile } from './arm64.ts';
import { createArm32Profile } from './arm32.ts';

export interface ArchDescriptor {
  /** Stable id, matches ArchProfile.id. */
  id: string;
  displayName: string;
  /** Vendored Unicorn asm.js filename (served from /vendor in the browser, read
   *  from vendor/ in Node). Each AlexAltea build is single-arch and publishes the
   *  global `uc`, so the matching file must be loaded for the chosen arch. */
  unicornFile: string;
  /** Build the concrete profile against a loaded `uc` namespace. */
  createProfile(uc: UnicornNamespace): ArchProfile;
  /** Sample program shown in the editor when this arch is selected. */
  defaultProgram: string;
}

// ARM64: build "Hi\n" on the stack, write(1, sp, 3), exit(0).
const ARM64_DEFAULT = [
  'mov  x9, #0x6948        // x9 = "iH" (little-endian bytes)',
  'movk x9, #0x000a, lsl #16   // add "\\n"',
  'str  x9, [sp, #-16]!    // push onto the stack',
  'mov  x0, #1             // fd = stdout',
  'mov  x1, sp             // buf = sp',
  'mov  x2, #3             // len = 3',
  'mov  x8, #64            // syscall: write',
  'svc  #0',
  'mov  x0, #0             // exit code 0',
  'mov  x8, #93            // syscall: exit',
  'svc  #0',
].join('\n');

// ARM32 (EABI): same idea — build "Hi\n" in r3, write(1, sp, 3), exit(0).
const ARM32_DEFAULT = [
  'movw r3, #0x6948        // r3 = "iH" (little-endian bytes)',
  'movt r3, #0x000a        // add "\\n" in the high half',
  'str  r3, [sp, #-16]!    // push onto the stack',
  'mov  r0, #1             // fd = stdout',
  'mov  r1, sp             // buf = sp',
  'mov  r2, #3             // len = 3',
  'mov  r7, #4             // EABI syscall: write',
  'svc  #0',
  'mov  r0, #0             // exit code 0',
  'mov  r7, #1             // EABI syscall: exit',
  'svc  #0',
].join('\n');

export const ARCHES: readonly ArchDescriptor[] = [
  {
    id: 'arm64',
    displayName: 'ARM64 (AArch64)',
    unicornFile: 'unicorn-aarch64.min.js',
    createProfile: createArm64Profile,
    defaultProgram: ARM64_DEFAULT,
  },
  {
    id: 'arm32',
    displayName: 'ARM32 (AArch32)',
    unicornFile: 'unicorn-arm.min.js',
    createProfile: createArm32Profile,
    defaultProgram: ARM32_DEFAULT,
  },
];

export const DEFAULT_ARCH_ID = 'arm64';

export function getArch(id: string): ArchDescriptor {
  const desc = ARCHES.find((a) => a.id === id);
  if (!desc) throw new Error(`Unknown architecture id: ${id}`);
  return desc;
}
