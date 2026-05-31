// Phase 2 UI entry. Spawns the emulator Web Worker, wires the toolbar
// (Assemble/Run/Step/Reset) to the worker message protocol, and renders the
// register / console / diagnostics panels off the Snapshot the worker returns.
// All real emulation work lives in the worker + harness; this file is glue.

import './style.css';
// The `?worker` suffix makes Vite bundle the worker (importScripts + its ESM
// imports) into one classic-worker file in BOTH dev and build — unlike the
// `new URL(..., import.meta.url)` form, which in dev serves an unbundled
// classic worker whose bare ESM imports can't execute.
import EmulatorWorker from './worker/emulator.worker.ts?worker';
import { SourceEditor } from './ui/editor.ts';
import type { Snapshot, WorkerRequest, WorkerResponse } from './emulator/protocol.ts';
import { ARCHES, DEFAULT_ARCH_ID, getArch } from './arch/registry.ts';

// The currently selected architecture. Each arch supplies its own sample program
// (build "Hi\n" on the stack, write, exit) — see src/arch/registry.ts.
let currentArchId = DEFAULT_ARCH_ID;

/** How long to wait for a `run` to respond before assuming a hung worker. */
const RUN_WALLCLOCK_MS = 5000;

// ---- DOM ----
const el = {
  editor: document.getElementById('editor')!,
  registers: document.getElementById('registers')!,
  flags: document.getElementById('flags')!,
  console: document.getElementById('console')!,
  diagnostics: document.getElementById('diagnostics')!,
  status: document.getElementById('status')!,
  asmError: document.getElementById('asm-error')!,
  arch: document.getElementById('arch') as HTMLSelectElement,
  btnAssemble: document.getElementById('btn-assemble') as HTMLButtonElement,
  btnRun: document.getElementById('btn-run') as HTMLButtonElement,
  btnStep: document.getElementById('btn-step') as HTMLButtonElement,
  btnReset: document.getElementById('btn-reset') as HTMLButtonElement,
};

const editor = new SourceEditor(el.editor, getArch(currentArchId).defaultProgram, {
  onChange: () => {
    // Editing invalidates a shown assembler error and any loaded program;
    // require a re-assemble either way.
    if (!el.asmError.hidden) clearAsmError();
    if (state.loaded) markStale();
  },
});

// ---- app state ----
interface AppState {
  ready: boolean;
  loaded: boolean;
  halted: boolean;
  inFlight: boolean;
  prevRegs: Map<string, bigint>;
}
const state: AppState = {
  ready: false,
  loaded: false,
  halted: false,
  inFlight: false,
  prevRegs: new Map(),
};

// ---- worker plumbing ----
let worker: Worker;
let runTimer: ReturnType<typeof setTimeout> | null = null;
// A 'reset' response returns registers to their initial values, so the
// change-diff would flag almost everything — suppress it for that one snapshot.
let pendingReset = false;

function spawnWorker(): void {
  worker = new EmulatorWorker();
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => handleResponse(ev.data);
  worker.onerror = (ev) => {
    setStatus(`Worker error: ${ev.message}`, 'error');
    finishRequest();
  };
}

function send(req: WorkerRequest): void {
  state.inFlight = true;
  if (req.type === 'reset') pendingReset = true;
  updateButtons();
  if (req.type === 'run') startRunTimer();
  worker.postMessage(req);
}

function startRunTimer(): void {
  clearRunTimer();
  runTimer = setTimeout(() => {
    // No response within the wall-clock budget: assume a hung worker. The
    // engine can't honor its own µs timeout, so the main thread is the only
    // line of defense — terminate and respawn a fresh, idle worker.
    worker.terminate();
    spawnWorker();
    state.ready = true; // a fresh worker re-boots; it'll re-emit 'ready' shortly
    state.loaded = false;
    finishRequest();
    setStatus('Stopped: run exceeded the time budget (possible infinite loop). Re-assemble to run again.', 'error');
  }, RUN_WALLCLOCK_MS);
}

function clearRunTimer(): void {
  if (runTimer !== null) {
    clearTimeout(runTimer);
    runTimer = null;
  }
}

function finishRequest(): void {
  state.inFlight = false;
  clearRunTimer();
  updateButtons();
}

function handleResponse(msg: WorkerResponse): void {
  switch (msg.type) {
    case 'ready':
      state.ready = true;
      finishRequest();
      setStatus('Engines loaded. Click Assemble to begin.', 'ok');
      break;
    case 'loaded':
      state.loaded = true;
      state.halted = false;
      clearAsmError();
      finishRequest();
      setStatus(`Assembled: ${msg.bytes} bytes, ${msg.count} instruction(s).`, 'ok');
      renderSnapshot(msg.snapshot, { resetDiff: true });
      break;
    case 'assemble-error':
      state.loaded = false;
      finishRequest();
      showAsmError(msg);
      setStatus(
        msg.line === undefined ? 'Assemble failed.' : `Assemble failed at line ${msg.line + 1}.`,
        'error',
      );
      break;
    case 'state': {
      const resetDiff = pendingReset;
      pendingReset = false;
      finishRequest();
      renderSnapshot(msg.snapshot, { resetDiff });
      if (resetDiff) setStatus('Reset to the start of the program.', 'ok');
      break;
    }
    case 'error':
      finishRequest();
      setStatus(`Error: ${msg.error}`, 'error');
      break;
  }
}

// ---- rendering ----
function renderSnapshot(snap: Snapshot, opts: { resetDiff: boolean }): void {
  state.halted = snap.halted;

  renderRegisters(snap, opts.resetDiff);
  renderFlags(snap);
  renderConsole(snap);
  renderDiagnostics(snap);
  updateButtons();

  if (snap.stopReason === 'error') {
    // A runtime fault: pin it to the faulting line with the same prominent error
    // UI as an assembler error, instead of leaving it only in the diagnostics.
    editor.highlightLine(null);
    showRuntimeError(snap);
  } else {
    if (!el.asmError.hidden) clearAsmError(); // drop a stale fault from a prior run
    editor.highlightLine(snap.line);
  }

  if (snap.halted) {
    const code = snap.exitCode === null ? '' : ` (exit code ${snap.exitCode})`;
    setStatus(`Halted: ${snap.stopReason}${code}.`, snap.stopReason === 'error' ? 'error' : 'ok');
  } else if (snap.stopReason === 'cap') {
    setStatus('Paused at instruction cap — still resumable with Run/Step.', 'warn');
  }
}

function fmtHex(v: bigint, wordBytes: number): string {
  return '0x' + v.toString(16).padStart(wordBytes * 2, '0');
}

function renderRegisters(snap: Snapshot, resetDiff: boolean): void {
  const next = new Map<string, bigint>();
  const frag = document.createDocumentFragment();

  for (const reg of snap.registers) {
    next.set(reg.name, reg.value);
    const changed = !resetDiff && state.prevRegs.get(reg.name) !== reg.value && state.prevRegs.has(reg.name);

    const row = document.createElement('div');
    row.className = 'reg' + (changed ? ' reg-changed' : '');
    const name = document.createElement('span');
    name.className = 'reg-name';
    name.textContent = reg.name;
    const val = document.createElement('span');
    val.className = 'reg-val';
    val.textContent = fmtHex(reg.value, snap.wordBytes);
    row.append(name, val);
    frag.append(row);
  }

  el.registers.replaceChildren(frag);
  state.prevRegs = next;
}

function renderFlags(snap: Snapshot): void {
  if (!snap.flags) {
    el.flags.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  const label = document.createElement('span');
  label.className = 'flags-label';
  label.textContent = `${snap.flagsName}:`;
  frag.append(label);
  for (const [key, bit] of Object.entries(snap.flags)) {
    const f = document.createElement('span');
    f.className = 'flag' + (bit ? ' flag-set' : '');
    f.textContent = `${key}=${bit}`;
    frag.append(f);
  }
  el.flags.replaceChildren(frag);
}

function renderConsole(snap: Snapshot): void {
  el.console.textContent = snap.console;
  el.console.scrollTop = el.console.scrollHeight;
}

function renderDiagnostics(snap: Snapshot): void {
  if (snap.diagnostics.length === 0) {
    el.diagnostics.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const d of snap.diagnostics) {
    const item = document.createElement('div');
    item.className = 'diag';
    item.textContent = d;
    frag.append(item);
  }
  el.diagnostics.replaceChildren(frag);
}

// ---- status + error helpers ----
function setStatus(text: string, kind: 'ok' | 'warn' | 'error'): void {
  el.status.textContent = text;
  el.status.className = `status status-${kind}`;
}

type AssembleError = Extract<WorkerResponse, { type: 'assemble-error' }>;

/** Render the shared error region: a headline (pinned to a line when known), an
 *  echo of the offending source line, and a plain-language hint. Drives the red
 *  line highlight too. Used for both assembler errors and runtime faults. */
function showError(opts: {
  line?: number;
  message: string;
  noLineLabel: string;
  lineText?: string;
  hint?: string;
}): void {
  const frag = document.createDocumentFragment();

  const headline = document.createElement('div');
  headline.className = 'asm-error-headline';
  headline.textContent =
    opts.line === undefined
      ? `${opts.noLineLabel}: ${opts.message}`
      : `Line ${opts.line + 1}: ${opts.message}`;
  frag.append(headline);

  // Echo the offending source line so the problem is visible without scanning.
  if (opts.lineText) {
    const code = document.createElement('div');
    code.className = 'asm-error-line';
    code.textContent = opts.lineText;
    frag.append(code);
  }

  if (opts.hint) {
    const hint = document.createElement('div');
    hint.className = 'asm-error-hint';
    hint.textContent = opts.hint;
    frag.append(hint);
  }

  el.asmError.replaceChildren(frag);
  el.asmError.hidden = false;
  editor.highlightErrorLine(opts.line ?? null);
}

function showAsmError(msg: AssembleError): void {
  showError({
    line: msg.line,
    message: msg.error,
    noLineLabel: 'Assembler error',
    lineText: msg.lineText,
    hint: msg.hint,
  });
}

function showRuntimeError(snap: Snapshot): void {
  const line = snap.line ?? undefined;
  const lineText = line === undefined ? undefined : editor.getText().split('\n')[line]?.trim() || undefined;
  showError({
    line,
    message: snap.fault ?? 'Execution faulted.',
    noLineLabel: 'Runtime error',
    lineText,
    hint: runtimeHint(snap.fault),
  });
}

/** A short, plain-language nudge keyed off the Unicorn fault text. */
function runtimeHint(fault: string | null): string | undefined {
  if (!fault) return undefined;
  const f = fault.toUpperCase();
  if (f.includes('UNMAPPED'))
    return 'The program touched an address that isn’t mapped. Check the pointer this instruction uses — e.g. `ldr r1, label` loads the value stored at `label`, not its address (use `adr r1, label` or `ldr r1, =label` for the address). Mapped regions: code 0x10000, data 0x20000, stack 0x30000.';
  if (f.includes('INSN_INVALID') || f.includes('INVALID INSTRUCTION'))
    return 'The CPU hit bytes it could not decode as an instruction — often execution ran past the code into data (a literal pool or a `.asciz` string). Make sure control flow can’t fall through into data.';
  return undefined;
}

function clearAsmError(): void {
  el.asmError.replaceChildren();
  el.asmError.hidden = true;
  editor.highlightErrorLine(null);
}

function markStale(): void {
  state.loaded = false;
  state.halted = false;
  editor.highlightLine(null);
  updateButtons();
  setStatus('Source changed — click Assemble to reload.', 'warn');
}

// ---- buttons ----
function updateButtons(): void {
  const idle = state.ready && !state.inFlight;
  el.btnAssemble.disabled = !idle;
  el.btnReset.disabled = !idle || !state.loaded;
  const canExec = idle && state.loaded && !state.halted;
  el.btnRun.disabled = !canExec;
  el.btnStep.disabled = !canExec;
}

el.btnAssemble.addEventListener('click', () => send({ type: 'load', source: editor.getText() }));
el.btnRun.addEventListener('click', () => send({ type: 'run' }));
el.btnStep.addEventListener('click', () => send({ type: 'step' }));
el.btnReset.addEventListener('click', () => send({ type: 'reset' }));

// ---- architecture selector ----
function populateArchSelect(): void {
  const frag = document.createDocumentFragment();
  for (const a of ARCHES) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.displayName;
    frag.append(opt);
  }
  el.arch.replaceChildren(frag);
  el.arch.value = currentArchId;
}

function switchArch(id: string): void {
  if (id === currentArchId) return;
  currentArchId = id;
  // Wipe per-program UI state, then load this arch's sample program. Clear the
  // loaded flag before swapping text so the editor's onChange doesn't fire the
  // "source changed" path against the previous program.
  state.loaded = false;
  state.halted = false;
  state.prevRegs = new Map();
  editor.setText(getArch(id).defaultProgram);
  editor.highlightLine(null);
  clearAsmError();
  el.registers.replaceChildren();
  el.flags.replaceChildren();
  el.console.textContent = '';
  el.diagnostics.replaceChildren();
  setStatus(`Switching to ${getArch(id).displayName}…`, 'warn');
  send({ type: 'select-arch', id });
}

el.arch.addEventListener('change', () => switchArch(el.arch.value));

// ---- boot ----
populateArchSelect();
setStatus('Loading engines…', 'warn');
updateButtons();
spawnWorker();
