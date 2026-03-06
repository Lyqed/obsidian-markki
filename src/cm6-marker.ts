import { Extension, RangeSetBuilder } from '@codemirror/state';
import { EditorView, ViewPlugin, DecorationSet, Decoration, WidgetType, ViewUpdate } from '@codemirror/view';

const ANKI_MARKER_RE = /<!--\s*anki(?:\s[^>]*)?\s*-->/g;

class AnkiDotWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'anki-card-indicator';
    span.setAttribute('aria-label', 'Anki card (move cursor here to edit marker)');
    return span;
  }
  eq(): boolean { return true; }
  ignoreEvent(): boolean { return true; }
}

const ankiMarkerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        ANKI_MARKER_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ANKI_MARKER_RE.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          const markerLine = view.state.doc.lineAt(start).number;

          if (markerLine !== cursorLine) {
            builder.add(start, end, Decoration.replace({ widget: new AnkiDotWidget() }));
          }
        }
      }

      return builder.finish();
    }
  },
  { decorations: (v: { decorations: DecorationSet }) => v.decorations }
);

const ankiMarkerTheme = EditorView.baseTheme({
  '.anki-card-indicator': {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: '#7c3aed',
    verticalAlign: 'middle',
    margin: '0 3px',
    cursor: 'default',
    opacity: '0.65',
  },
});

export function createAnkiMarkerExtension(
  onCursorChangeLine: (view: EditorView) => void
): Extension[] {
  return [
    ankiMarkerPlugin,
    ankiMarkerTheme,
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.selectionSet && !update.docChanged) return;

      const prevLine = update.startState.doc.lineAt(update.startState.selection.main.head).number;
      const currLine = update.state.doc.lineAt(update.state.selection.main.head).number;

      if (prevLine !== currLine) {
        onCursorChangeLine(update.view);
      }
    }),
  ];
}
