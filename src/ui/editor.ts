// CodeMirror 6 wrapper for the assembly source. Plain text — no ARM grammar yet
// (that's fine for Phase 2). Exposes the current text, a way to set it, and a
// single "highlight this source line" affordance the run/step loop drives off
// Snapshot.line (0-based; null clears the highlight).

import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';

/** Effect carrying the 0-based line to highlight, or null to clear. */
const setActiveLine = StateEffect.define<number | null>();

const activeLineDeco = Decoration.line({ class: 'cm-execLine' });

const activeLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setActiveLine)) continue;
      const zeroBased = effect.value;
      if (zeroBased === null) {
        deco = Decoration.none;
        continue;
      }
      const lineNo = zeroBased + 1; // CodeMirror doc lines are 1-based.
      if (lineNo >= 1 && lineNo <= tr.state.doc.lines) {
        const line = tr.state.doc.line(lineNo);
        deco = Decoration.set([activeLineDeco.range(line.from)]);
      } else {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

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
        extensions: [basicSetup, activeLineField, listener, EditorView.lineWrapping],
      }),
    });
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** Highlight the given 0-based source line (or clear with null). */
  highlightLine(zeroBased: number | null): void {
    this.view.dispatch({ effects: setActiveLine.of(zeroBased) });
  }

  focus(): void {
    this.view.focus();
  }
}
