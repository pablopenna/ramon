// Fixed-width source mapping: used by architectures whose instructions are all
// the same byte length (ARM64 = 4). The i-th instruction-bearing source line
// maps to byte offset i*length. Lines that emit no code (blank, comment-only,
// label-only, directive-only) are skipped.
//
// Limitation: a source line that assembles to more than one instruction (a
// multi-instruction pseudo-op, or a data directive emitting != length bytes)
// will desync the map from that point on. Acceptable for a teaching sandbox;
// documented in the README. Variable-length archs (x86) need a different
// strategy behind their own profile.

import type { SourceMap } from '../arch/ArchProfile.ts';

/** True if a logical source line emits a machine instruction. */
export function isInstructionLine(rawLine: string): boolean {
  // Strip line comments: ';', '//', and '#' (Keystone/LLVM-ish). Keep it simple.
  let line = rawLine;
  for (const marker of [';', '//']) {
    const idx = line.indexOf(marker);
    if (idx !== -1) line = line.slice(0, idx);
  }
  line = line.trim();
  if (line === '') return false;
  if (line.startsWith('.')) return false; // directive
  // label-only line: "foo:" (possibly with nothing after).
  if (/^[A-Za-z_.$][\w.$]*:\s*$/.test(line)) return false;
  // "label: instr" -> still an instruction line (the instr part emits code).
  return true;
}

export function buildFixedWidthSourceMap(
  source: string,
  instructionLength: number,
  totalBytes: number,
): SourceMap {
  const lines = source.split('\n');
  // instructionIndex -> source line number (0-based)
  const indexToLine: number[] = [];
  // source line number -> instruction index
  const lineToIndex = new Map<number, number>();

  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isInstructionLine(lines[i])) {
      indexToLine[idx] = i;
      lineToIndex.set(i, idx);
      idx++;
    }
  }

  const instructionCount = Math.floor(totalBytes / instructionLength);

  return {
    offsetToLine(offset: number): number | null {
      if (offset < 0 || offset >= totalBytes) return null;
      const instrIdx = Math.floor(offset / instructionLength);
      const line = indexToLine[instrIdx];
      return line === undefined ? null : line;
    },
    lineToOffset(line: number): number | null {
      const instrIdx = lineToIndex.get(line);
      if (instrIdx === undefined || instrIdx >= instructionCount) return null;
      return instrIdx * instructionLength;
    },
  };
}
