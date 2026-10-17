import React, { useEffect, useRef, useState } from "react";
import { fetchSuggestions } from "./suggest";

export interface ContextMenuTarget {
  from: number;
  to: number;
  text: string;
  x: number;
  y: number;
}

interface SuggestionPopupProps {
  target: ContextMenuTarget;
  onPick: (replacement: string) => void;
  onClose: () => void;
}

export const SuggestionPopup: React.FC<SuggestionPopupProps> = ({
  target,
  onPick,
  onClose,
}) => {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setSuggestions(null);

    fetchSuggestions(target.text, ac.signal)
      .then((items) => {
        setSuggestions(items);
        setSelectedIndex(0);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setSuggestions([]);
        }
      });

    return () => ac.abort();
  }, [target.text]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          suggestions && suggestions.length > 0 ? (prev + 1) % suggestions.length : 0
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          suggestions && suggestions.length > 0
            ? (prev - 1 + suggestions.length) % suggestions.length
            : 0
        );
      } else if (e.key === "Enter") {
        if (suggestions && suggestions.length > 0) {
          e.preventDefault();
          onPick(suggestions[selectedIndex]);
        }
      }
    };

    window.addEventListener("pointerdown", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onPick, selectedIndex, suggestions]);

  // Adjust popup position if it overflows viewport boundaries
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(target.x, window.innerWidth - 220),
    top: Math.min(target.y + 8, window.innerHeight - 260),
    zIndex: 1000,
  };

  return (
    <div ref={popupRef} className="suggestion-popup" style={style}>
      <div className="suggestion-header">
        <span className="suggestion-target-word">"{target.text}"</span>
        <span className="suggestion-badge">SymSpell</span>
      </div>

      <ul className="suggestion-list">
        {suggestions === null && (
          <li className="suggestion-status">
            <span className="spinner"></span> Looking up corrections…
          </li>
        )}

        {suggestions !== null && suggestions.length === 0 && (
          <li className="suggestion-status empty">No suggestions found</li>
        )}

        {suggestions &&
          suggestions.map((suggestion, idx) => (
            <li key={suggestion}>
              <button
                type="button"
                className={`suggestion-btn ${idx === selectedIndex ? "active" : ""}`}
                onClick={() => onPick(suggestion)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="suggestion-text">{suggestion}</span>
                {idx === 0 && <span className="top-choice">Best Match</span>}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
};
