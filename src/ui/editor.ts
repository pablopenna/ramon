// CodeMirror 6 wrapper for the assembly source. Plain text — no ARM grammar yet
// (that's fine for Phase 2). Exposes the current text, a way to set it, and a
// single "highlight this source line" affordance the run/step loop drives off
// Snapshot.line (0-based; null clears the highlight).

import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';

/** Effect carrying the 0-based line to highlight, or null to clear. */
const setActiveLine = StateEffect.define<number | null>();
/** Effect carrying the 0-based line of an assembler error, or null to clear. */
const setErrorLine = StateEffect.define<number | null>();

/** Build a single-line decoration field driven by `effect`. */
function lineHighlightField(
  effect: typeof setActiveLine,
  className: string,
): StateField<DecorationSet> {
  const deco = Decoration.line({ class: className });
  return StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(effect)) continue;
        const zeroBased = e.value;
        const lineNo = zeroBased === null ? 0 : zeroBased + 1; // CodeMirror lines are 1-based.
        if (lineNo >= 1 && lineNo <= tr.state.doc.lines) {
          set = Decoration.set([deco.range(tr.state.doc.line(lineNo).from)]);
        } else {
          set = Decoration.none;
        }
      }
      return set;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const activeLineField = lineHighlightField(setActiveLine, 'cm-execLine');
const errorLineField = lineHighlightField(setErrorLine, 'cm-errorLine');

export class SourceEditor {
  private readonly view: EditorView;

  constructor(parent: HTMLElement, initialDoc: string, opts: { onChange?: () => void } = {}) {
    const listener = EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange?.();
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [basicSetup, activeLineField, errorLineField, listener, EditorView.lineWrapping],
      }),
    });
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the whole document (e.g. when switching architecture) and clear the
   *  highlights, which referred to the previous program. */
  setText(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: [setActiveLine.of(null), setErrorLine.of(null)],
    });
  }

  /** Highlight the given 0-based source line (or clear with null). */
  highlightLine(zeroBased: number | null): void {
    this.view.dispatch({ effects: setActiveLine.of(zeroBased) });
  }

  /** Mark the given 0-based source line as an assembler error (or clear with null). */
  highlightErrorLine(zeroBased: number | null): void {
    this.view.dispatch({ effects: setErrorLine.of(zeroBased) });
  }

  focus(): void {
    this.view.focus();
  }
}
