// Source mapping: translate between assembled byte offsets (relative to the code
// base) and source lines, so the run/step loop can highlight the current line and
// pin a runtime fault to the instruction that caused it.
//
// Two strategies live here:
//   - buildExactSourceMap (preferred): measure each instruction-bearing line's
//     real assembled size and lay them out head-to-tail. Correct even when a line
//     emits != one fixed-width instruction — e.g. ARM's `ldr rN, =imm`
//     literal-pool load (8 bytes) or a data directive. Needs an assembler.
//   - buildFixedWidthSourceMap (fallback): assume every instruction is the same
//     byte length (ARM = 4). Cheap, but a line that emits a different number of
//     bytes desyncs the map from that point on. Used only when exact sizing can't
//     be completed. Variable-length archs (x86) will need their own strategy.

import type { SourceMap } from '../arch/ArchProfile.ts';

const LABEL_RE = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;
const EQU_RE = /^\s*\.(?:equ|set)\s+([A-Za-z_.$][\w.$]*)\s*,\s*(.+)$/;

/** Strip a `;` or `//` line comment, ignoring markers inside a quoted string
 *  (e.g. `.asciz "a // b"`). Returns the line up to the comment. */
export function stripComment(line: string): string {
  let quote: string | null = null; // open quote char, or null when outside a string
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++; // skip the escaped char
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ';') return line.slice(0, i);
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Drop comments from every line while preserving line count (so byte offsets and
 *  source-line indices stay aligned). Feed this to the assembler so Keystone's ARM
 *  parser never sees a `//`/`;` comment — which it otherwise mis-parses as part of
 *  a bare operand (e.g. `swi 0 // ...` -> "Invalid operand"). */
export function stripComments(source: string): string {
  return source.split('\n').map(stripComment).join('\n');
}

/** True if a logical source line emits a machine instruction. */
export function isInstructionLine(rawLine: string): boolean {
  const line = stripComment(rawLine).trim();
  if (line === '') return false;
  if (line.startsWith('.')) return false; // directive
  // label-only line: "foo:" (possibly with nothing after).
  if (/^[A-Za-z_.$][\w.$]*:\s*$/.test(line)) return false;
  // "label: instr" -> still an instruction line (the instr part emits code).
  return true;
}

/**
 * Collect every label and `.equ`/`.set` definition in the program, as a list of
 * standalone definition lines. Prepending these to a single probed instruction
 * lets forward references (e.g. `b loop`, `mov r0, #CONST`) resolve so the line
 * still assembles — and a probed line's *size* doesn't depend on the actual
 * target address, only on the instruction form, so dummy top-of-program
 * definitions are safe for measuring.
 */
export function collectDefinitions(lines: string[]): string[] {
  const defs: string[] = [];
  for (const raw of lines) {
    const code = stripComment(raw);
    const label = LABEL_RE.exec(code);
    if (label) defs.push(`${label[1]}:`);
    const equ = EQU_RE.exec(code);
    if (equ) defs.push(`.equ ${equ[1]}, ${equ[2].trim()}`);
  }
  return defs;
}

/** Reduce a source line to the bare instruction: drop the comment and any
 *  leading `label:`. */
export function stripToInstruction(rawLine: string): string {
  return stripComment(rawLine).replace(LABEL_RE, '').trim();
}

/**
 * Exact map: measure each instruction-bearing line by assembling it in isolation
 * (with all label/`.equ` definitions prepended so forward refs resolve), then lay
 * the lines out head-to-tail. Falls back to the fixed-width map when a line can't
 * be sized or the head-to-tail total overruns the real assembled size (e.g. the
 * assembler merged duplicate literal-pool entries) — i.e. when we can't fully
 * trust the per-line layout.
 */
export function buildExactSourceMap(
  source: string,
  totalBytes: number,
  fallbackLength: number | null,
  assembleLine: (text: string) => number | null,
): SourceMap {
  const lines = source.split('\n');
  const defs = collectDefinitions(lines);
  const prefix = defs.length ? defs.join('\n') + '\n' : '';

  const spans: { line: number; start: number; end: number }[] = [];
  const lineToStart = new Map<number, number>();
  let offset = 0;
  let trustworthy = true;

  for (let i = 0; i < lines.length; i++) {
    if (!isInstructionLine(lines[i])) continue;
    const size = assembleLine(prefix + stripToInstruction(lines[i]));
    if (size === null || size <= 0) {
      trustworthy = false;
      break;
    }
    spans.push({ line: i, start: offset, end: offset + size });
    lineToStart.set(i, offset);
    offset += size;
  }

  if (!trustworthy || offset > totalBytes) {
    return fallbackLength
      ? buildFixedWidthSourceMap(source, fallbackLength, totalBytes)
      : NULL_SOURCE_MAP;
  }

  return {
    offsetToLine(o: number): number | null {
      if (o < 0 || o >= totalBytes) return null;
      for (const s of spans) if (o >= s.start && o < s.end) return s.line;
      return null; // in trailing data, past the last instruction span
    },
    lineToOffset(line: number): number | null {
      const start = lineToStart.get(line);
      return start === undefined ? null : start;
    },
  };
}

const NULL_SOURCE_MAP: SourceMap = {
  offsetToLine: () => null,
  lineToOffset: () => null,
};

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
