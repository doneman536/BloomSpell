import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { WORD_REGEX } from "./spell";

const misspelledDecoration = Decoration.mark({ class: "cm-misspelled" });

export interface MisspelledWordTarget {
  from: number;
  to: number;
  text: string;
}

export function wordAtPosition(view: EditorView, pos: number): MisspelledWordTarget | null {
  const line = view.state.doc.lineAt(pos);
  for (const match of line.text.matchAll(WORD_REGEX)) {
    const from = line.from + match.index!;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, text: match[0] };
    }
  }
  return null;
}

export function spellcheckExtension(
  isWordValid: (word: string) => boolean,
  onMisspelledCountChange?: (count: number) => void
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      activeCaretPos = -1; // Caret position right after the latest edit (word currently being typed)

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        const head = update.state.selection.main.head;
        if (update.docChanged) {
          this.activeCaretPos = head;
        } else if (update.selectionSet && head !== this.activeCaretPos) {
          this.activeCaretPos = -1;
        }

        // Avoid re-decorating during IME composition
        if (update.view.composing) {
          this.decorations = this.decorations.map(update.changes);
          return;
        }

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        let lastLine = -1;
        let totalMisspelled = 0;

        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            if (line.from > lastLine) {
              lastLine = line.from;
              for (const match of line.text.matchAll(WORD_REGEX)) {
                const s = line.from + match.index!;
                const e = s + match[0].length;
                const token = match[0];

                // Skip underlining the word currently being typed until caret leaves it
                if (this.activeCaretPos >= s && this.activeCaretPos <= e) {
                  continue;
                }

                if (!isWordValid(token)) {
                  builder.add(s, e, misspelledDecoration);
                  totalMisspelled++;
                }
              }
            }
            pos = line.to + 1;
          }
        }

        if (onMisspelledCountChange) {
          onMisspelledCountChange(totalMisspelled);
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
