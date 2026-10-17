import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { Bloom } from "./bloom";
import { makeChecker } from "./spell";
import { spellcheckExtension, wordAtPosition } from "./spellPlugin";
import { SuggestionPopup, type ContextMenuTarget } from "./SuggestionPopup";

const STORAGE_KEY = "sc_bloom_notepad_text";

const SAMPLE_TEXT = `Welcome to the Bloom Filter Spell Checker demo!

Try right clicking any underlined word to get instant suggestions.

Here are a few deliberate typos to test:
- Can you please recieve the package tomorrow?
- I am definately going to teh party later.
- This algoritm runs in microseconds with zero network calls for valid words.
- Incredable performance with xxHash32 and double hashing!`;

interface EditorProps {
  bloom: Bloom;
  onStatsChange?: (stats: { words: number; chars: number; typos: number }) => void;
}

export const Editor: React.FC<EditorProps> = ({ bloom, onStatsChange }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [contextTarget, setContextTarget] = useState<ContextMenuTarget | null>(null);
  const [typoCount, setTypoCount] = useState<number>(0);

  const isWordValid = useMemo(() => makeChecker(bloom), [bloom]);

  useEffect(() => {
    let saveTimer: number | undefined;

    const initialText = localStorage.getItem(STORAGE_KEY) ?? SAMPLE_TEXT;

    const updateMetrics = (text: string, currentTypos: number) => {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      if (onStatsChange) {
        onStatsChange({ words, chars, typos: currentTypos });
      }
    };

    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          spellcheckExtension(isWordValid, (count) => {
            setTypoCount(count);
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const docString = update.state.doc.toString();
              window.clearTimeout(saveTimer);
              saveTimer = window.setTimeout(() => {
                localStorage.setItem(STORAGE_KEY, docString);
              }, 400);

              updateMetrics(docString, typoCount);
            }
          }),
          EditorView.domEventHandlers({
            contextmenu(event, editorView) {
              const coords = { x: event.clientX, y: event.clientY };
              const pos = editorView.posAtCoords(coords);
              if (pos == null) return false;

              const hit = wordAtPosition(editorView, pos);
              if (!hit || isWordValid(hit.text)) {
                // If the clicked word is valid, allow browser default context menu
                return false;
              }

              event.preventDefault();
              setContextTarget({
                ...hit,
                x: event.clientX,
                y: event.clientY,
              });
              return true;
            },
          }),
        ],
      }),
    });

    viewRef.current = view;
    updateMetrics(initialText, typoCount);

    return () => {
      window.clearTimeout(saveTimer);
      view.destroy();
    };
  }, [isWordValid]);

  // Update stats whenever typo count updates
  useEffect(() => {
    if (viewRef.current && onStatsChange) {
      const text = viewRef.current.state.doc.toString();
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      onStatsChange({ words, chars, typos: typoCount });
    }
  }, [typoCount, onStatsChange]);

  const handleApplyReplacement = (replacement: string) => {
    if (!contextTarget || !viewRef.current) return;
    const view = viewRef.current;

    view.dispatch({
      changes: { from: contextTarget.from, to: contextTarget.to, insert: replacement },
      selection: { anchor: contextTarget.from + replacement.length },
    });

    view.focus();
    setContextTarget(null);
  };

  const handleLoadSample = () => {
    if (!viewRef.current) return;
    const view = viewRef.current;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: SAMPLE_TEXT },
    });
    view.focus();
  };

  const handleClear = () => {
    if (!viewRef.current) return;
    const view = viewRef.current;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
    view.focus();
  };

  return (
    <div className="editor-wrapper">
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="editor-status-dot"></span>
          <span className="toolbar-title">Document Editor</span>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="toolbar-btn secondary" onClick={handleLoadSample}>
            Load Sample Typos
          </button>
          <button type="button" className="toolbar-btn danger" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>

      <div ref={hostRef} className="editor-canvas" />

      {contextTarget && (
        <SuggestionPopup
          target={contextTarget}
          onPick={handleApplyReplacement}
          onClose={() => setContextTarget(null)}
        />
      )}
    </div>
  );
};
