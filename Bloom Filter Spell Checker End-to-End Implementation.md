# Bloom Filter Spell Checker: End-to-End Implementation

Oct 17, 2026 · @Kaif Shaik

## Overview and architecture

The checker splits the work in two: a 1 MiB Bloom filter that the browser downloads once and uses to check every word locally, and a small FastAPI service that returns up to 8 suggestions only for words the filter rejects.

1. **Build (offline, once per word-list change).** `tools/build.py` reads the JSON word list and writes the filter file, a manifest, a frequency list for the backend, and golden test vectors.
2. **Page load.** The browser fetches `manifest.json`, then the versioned `bloom.<tag>.bin`, and keeps it in memory as a byte array.
3. **Typing.** CodeMirror checks the words in view against the filter. No network call is made, and a correct word is never flagged.
4. **Right-click on an underlined word.** The browser calls `GET /api/suggest`. SymSpell finds candidates within 2 edits, ranked by distance and then word frequency, and the top 8 come back.

&#91;embedded content: architecture · build, browser and EC2 instance\]

The browser holds the filter and decides alone. nginx serves the files, and FastAPI answers only suggestion requests.

The filter answers “is this a word?” in microseconds with no server load. The server handles only the harder question, “what did they mean?”, and is called rarely.

Two properties drive the design. A Bloom filter has no false negatives, so a valid word is never underlined. Its only error is a rare false positive: a misspelling that passes as correct.

## Parameters and sizing

With n = 470,000 words, a 1% target, a filter of 2^23 bits (1 MiB) and k = 7 probes, the real false-positive rate is about 0.04%.

| Parameter | Value | Why |
| --- | --- | --- |
| n | counted from the word list | The dictionary is static, so no safety multiplier is needed. |
| p (target) | 0.01 | Upper bound on misspellings that slip through. |
| m | 2^23 = 8,388,608 bits (1 MiB) | The ideal size for 1% is about 4.5M bits. Rounding up to a power of two lets the code use `& (m-1)` and lowers the real rate. |
| k | 7 | The optimum for this m is about 12, but extra probes cost time for little gain. The script caps k at 7. |
| Real false-positive rate | about 0.038% | About 1 misspelling in 2,600 is missed. |

```latex
p \approx \left(1 - e^{-kn/m}\right)^{k}
```

For near-zero misses, set m to 2^24 bits (2 MiB). The rate drops to about 0.0006% and nothing else changes.

### Hashing

Two xxHash32 calls, one per seed, give h1 and h2. Double hashing derives all k positions from them.

```latex
p_i = (h_1 + i \cdot h_2) \bmod m, \quad h_2 \text{ odd}, \quad i = 0 \ldots k-1
```

- h1 = xxh32(word, seed1). h2 = xxh32(word, seed2) with the lowest bit forced to 1.
- With m a power of two and h2 odd, the k probes never repeat.
- Python and JavaScript must produce identical positions. The golden vectors in the testing section enforce this.
- Before hashing, words are NFC-normalized and lowercased, and typographic apostrophes become `'`.

## Project structure and setup

The repo has four parts, and the build script feeds the other two.

```text
spellcheck/
├── tools/
│   └── build.py              # words.json → bloom file, manifest, freq.txt, golden.json
├── backend/
│   ├── app/main.py           # FastAPI + SymSpell
│   ├── data/freq.txt         # generated; never served publicly
│   ├── tests/test_suggest.py
│   └── requirements.txt
├── frontend/
│   ├── public/bloom/         # generated: manifest.json + bloom.<tag>.bin
│   ├── tests/golden.json     # generated
│   └── src/                  # bloom.ts spell.ts spellPlugin.ts suggest.ts
│                             # SuggestionPopup.tsx Editor.tsx App.tsx
└── deploy/
    ├── nginx.conf
    └── spellcheck.service
```

Prerequisites: Python 3.11+, Node 20+, and a `words.json` whose keys are the words. The values can be counts or anything else.

```bash
python -m venv .venv && source .venv/bin/activate
pip install fastapi "uvicorn[standard]" symspellpy xxhash wordfreq pytest httpx

npm create vite@latest frontend -- --template react-ts
cd frontend
npm i xxhash-wasm @codemirror/state @codemirror/view @codemirror/commands
npm i -D vitest
```

`backend/requirements.txt` needs only `fastapi`, `uvicorn[standard]` and `symspellpy`. `xxhash` and `wordfreq` are build-time tools, so they stay out of the server's requirements.

## Build script (Python)

`tools/build.py` turns `words.json` into everything the other parts need, and it checks its own output before finishing.

```python
#!/usr/bin/env python3
"""words.json -> Bloom filter file, manifest, frequency list, golden vectors."""
import argparse
import hashlib
import json
import math
import random
import re
import string
import struct
import unicodedata
from pathlib import Path

import xxhash

SEED1, SEED2 = 0x9E3779B1, 0x85EBCA77
MAGIC = b"SPBF"
HEADER = struct.Struct("<4sBBBBIII")  # magic, format, k, log2m, reserved, seed1, seed2, n = 20 bytes
WORD_RE = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")


def normalize(word: str) -> str:
    return unicodedata.normalize("NFC", word).replace("\u2019", "'").strip().lower()


def positions(word: str, k: int, mask: int) -> list[int]:
    data = word.encode("utf-8")
    h1 = xxhash.xxh32_intdigest(data, SEED1)
    h2 = xxhash.xxh32_intdigest(data, SEED2) | 1
    return [(h1 + i * h2) & mask for i in range(k)]


def contains(bits: bytes, word: str, k: int, mask: int) -> bool:
    return all(bits[p >> 3] & (1 << (p & 7)) for p in positions(word, k, mask))


def size_filter(n: int, p: float, k_max: int):
    ideal = -n * math.log(p) / math.log(2) ** 2
    log2m = max(10, math.ceil(math.log2(ideal)))
    m = 1 << log2m
    k = max(1, min(k_max, round(m / n * math.log(2))))
    fp = (1 - math.exp(-k * n / m)) ** k
    return log2m, m, k, fp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", default="words.json")
    ap.add_argument("--public-dir", default="frontend/public/bloom")
    ap.add_argument("--freq-out", default="backend/data/freq.txt")
    ap.add_argument("--golden", default="frontend/tests/golden.json")
    ap.add_argument("--freq-top", type=int, default=150_000)
    ap.add_argument("--p", type=float, default=0.01)
    ap.add_argument("--kmax", type=int, default=7)
    a = ap.parse_args()

    # 1. Load and normalize
    raw = json.loads(Path(a.words).read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    skipped = 0
    for key, value in raw.items():
        w = normalize(key)
        if not WORD_RE.match(w):
            skipped += 1
            continue
        c = int(value) if isinstance(value, (int, float)) and value > 0 else 0
        counts[w] = max(counts.get(w, 0), c)
    if not any(counts.values()):  # no usable counts in the JSON: fall back to wordfreq
        from wordfreq import word_frequency
        counts = {w: max(1, int(word_frequency(w, "en") * 1e9)) for w in counts}
    else:
        counts = {w: c or 1 for w, c in counts.items()}
    words = sorted(counts)
    n = len(words)

    # 2. Size and fill the filter
    log2m, m, k, fp = size_filter(n, a.p, a.kmax)
    mask = m - 1
    bits = bytearray(m // 8)
    for w in words:
        for pos in positions(w, k, mask):
            bits[pos >> 3] |= 1 << (pos & 7)
    bits = bytes(bits)

    # 3. Verify: no false negatives, then measure the false-positive rate
    assert all(contains(bits, w, k, mask) for w in words), "false negative (bug)"
    known, rng, tested, hits = set(words), random.Random(1), 0, 0
    for _ in range(200_000):
        s = "".join(rng.choices(string.ascii_lowercase, k=rng.randint(5, 10)))
        if s not in known:
            tested += 1
            hits += contains(bits, s, k, mask)

    # 4. Write the filter, manifest, frequency list and golden vectors
    blob = HEADER.pack(MAGIC, 1, k, log2m, 0, SEED1, SEED2, n) + bits
    sha = hashlib.sha256(blob).hexdigest()
    name = f"bloom.{sha[:10]}.bin"
    pub = Path(a.public_dir)
    pub.mkdir(parents=True, exist_ok=True)
    (pub / name).write_bytes(blob)
    manifest = {"file": name, "sha256": sha, "bytes": len(blob),
                "k": k, "log2m": log2m, "n": n, "expected_fp": fp}
    (pub / "manifest.json").write_text(json.dumps(manifest, indent=2))
    newest = sorted(pub.glob("bloom.*.bin"), key=lambda f: f.stat().st_mtime, reverse=True)
    for old in newest[2:]:  # keep the current and previous version
        old.unlink()

    top = sorted(words, key=lambda w: -counts[w])[: a.freq_top]
    freq = Path(a.freq_out)
    freq.parent.mkdir(parents=True, exist_ok=True)
    freq.write_text("".join(f"{w} {counts[w]}\n" for w in top), encoding="utf-8")

    present = words[:: max(1, n // 20)][:20]
    absent = [w for w in ("teh", "recieve", "xqzvt", "speling", "definately") if w not in known]
    cases = [{"word": w, "positions": positions(w, k, mask), "present": contains(bits, w, k, mask)}
             for w in present + absent]
    golden = Path(a.golden)
    golden.parent.mkdir(parents=True, exist_ok=True)
    golden.write_text(json.dumps({"k": k, "mask": mask, "seed1": SEED1, "seed2": SEED2, "cases": cases}, indent=2))

    print(f"n={n:,} (skipped {skipped:,})  m=2^{log2m}  k={k}  {name} ({len(blob) / 1024:.0f} KiB)")
    print(f"false-positive rate: expected {fp:.4%}, measured {hits / tested:.4%} over {tested:,} random non-words")


if __name__ == "__main__":
    main()
```

Run it from the repo root:

```bash
python tools/build.py --words words.json
```

It prints the expected and measured false-positive rates, and it aborts if any dictionary word fails to pass the filter.

How the script treats the earlier plan:

- **No `.env` secret.** The seeds are public constants stored in the file header. The browser must know them to compute the same positions, so they cannot be secret, and the word list is not sensitive.
- **n comes from the data,** not from a doubled estimate. k is the nearest integer to the optimum, capped at 7. Past the optimum, extra probes raise the error rate and add cost.
- **Versioned output.** A changed word list gives a new content hash and a new file name. The script keeps the current and previous files so clients holding an old manifest do not hit a 404.
- **Suggestion dictionary.** `freq.txt` holds only the `--freq-top` most frequent words (150,000 by default). This keeps SymSpell's memory down and limits suggestions to common words. The filter still contains every word.
- **No gzip for the filter.** About 32% of its bits are set, so it compresses by under 10%.

## Filter file format

The `.bin` file is a 20-byte header followed by the bit array, so the browser reads k, m and the seeds from the file and hardcodes nothing. All integers are little-endian.

| Offset | Size (bytes) | Field |
| --- | --- | --- |
| 0 | 4 | Magic `SPBF` |
| 4 | 1 | Format version (1) |
| 5 | 1 | k, the number of probes |
| 6 | 1 | log2(m) |
| 7 | 1 | Reserved (0) |
| 8 | 4 | seed1 (u32) |
| 12 | 4 | seed2 (u32) |
| 16 | 4 | n, the number of words inserted (u32) |
| 20 | m / 8 | Bit array |

With m = 2^23 the whole file is 1,048,596 bytes.

Bit order is fixed on both sides: probe position `p` lives in byte `p >> 3` under mask `1 << (p & 7)`.

`manifest.json` is the only file with a stable URL. It is served with `no-cache`, and it points to the immutable, content-hashed filter file:

```json
{
  "file": "bloom.3f9a1c07de.bin",
  "sha256": "<64 hex characters>",
  "bytes": 1048596,
  "k": 7,
  "log2m": 23,
  "n": 470000,
  "expected_fp": 0.000378
}
```

The values above are an example. Your build prints the real ones. The browser checks the downloaded bytes against `sha256` before using them.

## Backend (FastAPI + SymSpell)

One endpoint, `GET /api/suggest`, returns up to 8 words within 2 edits of the misspelling, ordered by edit distance and then by frequency.

```python
# backend/app/main.py
import os
import re
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, Query, Response
from symspellpy import SymSpell, Verbosity

FREQ_FILE = Path(os.environ.get("FREQ_FILE", "data/freq.txt"))
WORD_RE = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")
LIMIT = 8

sym = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
if not sym.load_dictionary(str(FREQ_FILE), term_index=0, count_index=1, separator=" "):
    raise RuntimeError(f"could not load {FREQ_FILE}")

app = FastAPI(docs_url=None, redoc_url=None)


@lru_cache(maxsize=50_000)
def suggest_words(word: str) -> tuple[tuple[str, int], ...]:
    # Distance 1 first. Widen to 2 only if there is room and the word is long enough.
    items = sym.lookup(word, Verbosity.ALL, max_edit_distance=1)
    if len(items) < LIMIT and len(word) > 4:
        items = sym.lookup(word, Verbosity.ALL, max_edit_distance=2)
    return tuple((s.term, s.distance) for s in items[:LIMIT])


@app.get("/api/suggest")
def suggest(response: Response, word: str = Query(..., min_length=1, max_length=40)):
    w = word.strip().lower().replace("\u2019", "'")
    response.headers["Cache-Control"] = "public, max-age=86400"
    if not WORD_RE.match(w) or w in sym.words:
        return {"word": word, "suggestions": []}
    return {"word": word, "suggestions": [{"term": t, "distance": d} for t, d in suggest_words(w)]}


@app.get("/api/health")
def health():
    return {"ok": True, "words": len(sym.words)}
```

`backend/requirements.txt`:

```text
fastapi
uvicorn[standard]
symspellpy
```

Run it locally and try one request:

```bash
cd backend
FREQ_FILE=data/freq.txt uvicorn app.main:app --port 8000
curl 'localhost:8000/api/suggest?word=recieve'
```

The response has this shape: `{"word": "recieve", "suggestions": [{"term": "...", "distance": 1}, ...]}`.

Choices built into this service:

- **Distance 1 first.** Most typos are one edit away. Distance 2 runs only when fewer than 8 results were found and the word has more than 4 letters, because short words match a huge number of words at distance 2.
- **Ranking.** SymSpell sorts by distance, then by the counts in `freq.txt`. Without real counts, “teh” could suggest obscure words before “the”.
- **Edit metric.** `symspellpy` counts a swapped pair of adjacent letters as one edit (optimal string alignment, a close relative of Damerau-Levenshtein), so “wierd” is one edit from “weird”.
- **Known-word check.** The filter never sends a real word, because it has no false negatives. The check only covers an out-of-date filter file in a user's browser.
- **Validation.** Words over 40 characters or outside the pattern return an empty list without any lookup.
- **Caching.** An in-process cache of 50,000 words, plus a one-day `Cache-Control`, lets the browser and nginx answer repeats.
- **One worker.** Each uvicorn worker holds its own copy of the SymSpell index. The index at distance 2 can be large, so measure the process memory after startup on the target instance. If it is too high, lower `--freq-top` in the build or set a smaller `prefix_length`.

## Frontend 1: loading the filter and checking words

Two small modules do the checking. `bloom.ts` downloads and parses the filter, and `spell.ts` decides which tokens are checked at all.

```ts
// src/bloom.ts
import xxhash from "xxhash-wasm";

export type H32 = (data: Uint8Array, seed?: number) => number;

export interface Bloom {
  has(word: string): boolean;
  k: number;
  n: number;
}

const encoder = new TextEncoder();

export function positions(
  h32: H32, word: string, k: number, mask: number, seed1: number, seed2: number,
): number[] {
  const data = encoder.encode(word);
  const h1 = h32(data, seed1) >>> 0;
  const h2 = (h32(data, seed2) | 1) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) & mask);
  return out;
}

export function parseBloom(buf: ArrayBuffer, h32: H32): Bloom {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SPBF" || dv.getUint8(4) !== 1) throw new Error("unsupported filter file");
  const k = dv.getUint8(5);
  const log2m = dv.getUint8(6);
  const seed1 = dv.getUint32(8, true);
  const seed2 = dv.getUint32(12, true);
  const n = dv.getUint32(16, true);
  if (log2m < 3 || log2m > 30) throw new Error("bad filter size");
  const bits = new Uint8Array(buf, 20);
  if (bits.length !== 2 ** (log2m - 3)) throw new Error("truncated filter file");
  const mask = 2 ** log2m - 1;
  return {
    k,
    n,
    has: (word) =>
      positions(h32, word, k, mask, seed1, seed2).every((p) => (bits[p >> 3] & (1 << (p & 7))) !== 0),
  };
}

export async function loadBloom(base = "/bloom"): Promise<Bloom> {
  const [{ h32Raw }, manifest] = await Promise.all([
    xxhash(),
    fetch(`${base}/manifest.json`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
      return r.json() as Promise<{ file: string; sha256: string }>;
    }),
  ]);
  const res = await fetch(`${base}/${manifest.file}`);
  if (!res.ok) throw new Error(`filter: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== manifest.sha256) throw new Error("filter checksum mismatch");
  return parseBloom(buf, h32Raw);
}
```

```ts
// src/spell.ts
import type { Bloom } from "./bloom";

// A word is letters, digits or underscores, with optional inner apostrophes or hyphens.
export const WORD = /[\p{L}\p{M}\p{N}_]+(?:['\u2019-][\p{L}\p{M}\p{N}_]+)*/gu;
const PLAIN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

export function makeChecker(bloom: Bloom) {
  const memo = new Map<string, boolean>();
  return function isOk(raw: string): boolean {
    const w = raw.normalize("NFC").replace(/\u2019/g, "'");
    if (!PLAIN.test(w)) return true; // digits, accents, URLs: not checked
    if (w.length > 1 && w === w.toUpperCase()) return true; // acronyms: not checked
    const key = w.toLowerCase();
    let ok = memo.get(key);
    if (ok === undefined) {
      ok = bloom.has(key);
      if (memo.size > 50_000) memo.clear();
      memo.set(key, ok);
    }
    return ok;
  };
}
```

`vite.config.ts`, with a dev proxy so `/api` reaches the local backend:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: { environment: "node" },
});
```

Points to know:

- **The hash must match Python bit for bit.** `h32Raw` takes bytes and a seed. This was written against `xxhash-wasm` 1.x, so if you install a different major version, run the golden test in the testing section before trusting any result.
- **Caching.** The `.bin` is immutable and cached for a year, so a repeat visit fetches only the small manifest.
- **HTTPS is required** for the checksum step, because `crypto.subtle` exists only on secure origins (localhost counts).
- **Tokens that are never flagged:** words with digits or accents, URLs, and all-caps acronyms. This avoids false alarms the dictionary cannot judge.

## Frontend 2: the editor

A plain `<textarea>` cannot underline single words, so the notepad uses CodeMirror 6. A small plugin underlines misspelled words, and the editor component wires it up.

```ts
// src/spellPlugin.ts
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { WORD } from "./spell";

const mark = Decoration.mark({ class: "cm-misspelled" });

export function wordAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WORD)) {
    const from = line.from + m.index!;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return { from, to, text: m[0] };
  }
  return null;
}

export function spellcheck(isOk: (word: string) => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      active = -1; // caret position right after the latest edit: the word being typed

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        const head = u.state.selection.main.head;
        if (u.docChanged) this.active = head;
        else if (u.selectionSet && head !== this.active) this.active = -1;
        if (u.view.composing) {
          this.decorations = this.decorations.map(u.changes);
          return;
        }
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        let lastLine = -1;
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            if (line.from > lastLine) {
              lastLine = line.from;
              for (const m of line.text.matchAll(WORD)) {
                const s = line.from + m.index!;
                const e = s + m[0].length;
                if (this.active >= s && this.active <= e) continue; // still typing this word
                if (!isOk(m[0])) builder.add(s, e, mark);
              }
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
```

```tsx
// src/Editor.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { Bloom } from "./bloom";
import { makeChecker } from "./spell";
import { spellcheck, wordAt } from "./spellPlugin";
import { SuggestionPopup, type Target } from "./SuggestionPopup";

const STORAGE_KEY = "notepad.text";

export function Editor({ bloom }: { bloom: Bloom }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const isOk = useMemo(() => makeChecker(bloom), [bloom]);

  useEffect(() => {
    let timer: number | undefined;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: localStorage.getItem(STORAGE_KEY) ?? "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          spellcheck(isOk),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(
              () => localStorage.setItem(STORAGE_KEY, u.state.doc.toString()),
              500,
            );
          }),
          EditorView.domEventHandlers({
            contextmenu(e, v) {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              const hit = pos == null ? null : wordAt(v, pos);
              if (!hit || isOk(hit.text)) return false; // not a flagged word: normal menu
              e.preventDefault();
              setTarget({ ...hit, x: e.clientX, y: e.clientY });
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      window.clearTimeout(timer);
      view.destroy();
    };
  }, [isOk]);

  const apply = (t: Target, text: string) => {
    const view = viewRef.current!;
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: text },
      selection: { anchor: t.from + text.length },
    });
    view.focus();
    setTarget(null);
  };

  return (
    <>
      <div ref={host} className="editor" />
      {target && (
        <SuggestionPopup target={target} onPick={(s) => apply(target, s)} onClose={() => setTarget(null)} />
      )}
    </>
  );
}
```

When a word gets underlined:

- **Not while it is being typed.** `active` holds the caret position right after the latest edit, and a word touching it is skipped. Typing “teh” shows nothing. Typing a space or punctuation moves the caret past the word, and then it is checked.
- **Clicking into an old misspelling keeps its underline.** Any caret move without an edit clears `active`.
- **Only the lines in view are scanned** (`visibleRanges`), so pasting a long text does not freeze the page. One lookup is two hashes and 7 bit reads, so no Web Worker is needed at this size.
- **IME input** (for example Japanese) is left alone: during composition the existing underlines are shifted, not recomputed.
- **Right-click opens suggestions** for a flagged word only. Long-press fires the same event on most Android browsers. iOS Safari may not, so add a `click` handler the same way if you need tap support.
- **The note is saved** to `localStorage` 500 ms after the last edit.

## Frontend 3: suggestions and the app shell

Only the single flagged word is sent to the server, and only when the user right-clicks it. The rest of the text never leaves the browser.

```ts
// src/suggest.ts
const cache = new Map<string, string[]>();

export function matchCase(original: string, terms: string[]): string[] {
  const first = original[0];
  const allCaps = original.length > 1 && original === original.toUpperCase();
  const capitalized = first !== first.toLowerCase();
  return terms.map((t) => (allCaps ? t.toUpperCase() : capitalized ? t[0].toUpperCase() + t.slice(1) : t));
}

export async function fetchSuggestions(word: string, signal?: AbortSignal): Promise<string[]> {
  const key = word.toLowerCase();
  let terms = cache.get(key);
  if (!terms) {
    const res = await fetch(`/api/suggest?word=${encodeURIComponent(key)}`, { signal });
    if (!res.ok) throw new Error(`suggest: HTTP ${res.status}`);
    const data = (await res.json()) as { suggestions: { term: string }[] };
    terms = data.suggestions.map((s) => s.term);
    cache.set(key, terms);
  }
  return matchCase(word, terms);
}
```

```tsx
// src/SuggestionPopup.tsx
import { useEffect, useRef, useState } from "react";
import { fetchSuggestions } from "./suggest";

export interface Target {
  from: number;
  to: number;
  text: string;
  x: number;
  y: number;
}

interface Props {
  target: Target;
  onPick: (suggestion: string) => void;
  onClose: () => void;
}

export function SuggestionPopup({ target, onPick, onClose }: Props) {
  const [items, setItems] = useState<string[] | null>(null);
  const ref = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setItems(null);
    fetchSuggestions(target.text, ac.signal)
      .then(setItems)
      .catch((e) => {
        if (e.name !== "AbortError") setItems([]);
      });
    return () => ac.abort();
  }, [target.text]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onClose);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onClose);
    };
  }, [onClose]);

  return (
    <ul ref={ref} className="suggest" style={{ position: "fixed", left: target.x, top: target.y }}>
      {items === null && <li className="muted">Looking…</li>}
      {items?.length === 0 && <li className="muted">No suggestions</li>}
      {items?.map((s) => (
        <li key={s}>
          <button onClick={() => onPick(s)}>{s}</button>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/App.tsx
import { useEffect, useState } from "react";
import { loadBloom, type Bloom } from "./bloom";
import { Editor } from "./Editor";

export default function App() {
  const [bloom, setBloom] = useState<Bloom | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBloom().then(setBloom).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p>Could not load the dictionary: {error}</p>;
  if (!bloom) return <p>Loading dictionary…</p>;
  return (
    <main>
      <h1>Notepad</h1>
      <Editor bloom={bloom} />
    </main>
  );
}
```

```css
/* src/index.css */
.editor .cm-editor { height: 70vh; border: 1px solid #ccc; font-size: 16px; }
.editor .cm-content { padding: 12px; }
.cm-misspelled { text-decoration: underline wavy #d33; text-decoration-skip-ink: none; }
.suggest { margin: 0; padding: 4px; list-style: none; background: #fff; border: 1px solid #ccc;
  border-radius: 6px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); z-index: 10; }
.suggest button { display: block; width: 100%; text-align: left; padding: 4px 12px;
  border: 0; background: none; cursor: pointer; font: inherit; }
.suggest button:hover { background: #eef; }
.suggest .muted { padding: 4px 12px; color: #777; }
```

Notes on behavior:

- **Capitalization.** The server works in lowercase, and `matchCase` restores the user's style, so “Teh” offers “The”.
- **Repeat clicks are free.** Results are cached per word in the page, and nginx and the browser cache them too.
- **Failures are quiet.** If the request fails, the popup shows “No suggestions” and the editor keeps working, because the underline never depended on the server.
- **Edge of the screen.** The popup opens at the click position. Clamp `left` and `top` to the window size if you expect clicks near the right or bottom edge.

## Deployment on EC2 with nginx

One EC2 instance runs nginx (static files, caching, rate limits, HTTPS) and the FastAPI service, which listens only on localhost. The static files could sit on S3 and CloudFront instead, but the suggest API still needs a server, so one instance is simpler.

1. **Launch the instance.** The SymSpell index decides the memory you need, so start with 2 GB (t3.small), measure, and resize if needed. In the security group, open ports 80 and 443 only. Keep 8000 closed.
2. **Build locally.** Run `python tools/build.py`, then `npm run build` in `frontend/`. Vite copies `public/bloom/` into `dist/`.
3. **Copy to the server.** The first line sends the site, the second the backend and its `freq.txt`.
4. **Install the backend** in a virtualenv on the server.
5. **Start it** with the systemd unit below.
6. **Configure nginx and HTTPS** with the site file below and certbot.

```bash
rsync -a frontend/dist/ user@your-ec2-host:/var/www/spellcheck/dist/
rsync -a --exclude .venv backend/ user@your-ec2-host:/opt/spellcheck/backend/

# on the server
cd /opt/spellcheck/backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`deploy/spellcheck.service`:

```ini
[Unit]
Description=Spellcheck suggestion API
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/spellcheck/backend
Environment=FREQ_FILE=/opt/spellcheck/backend/data/freq.txt
ExecStart=/opt/spellcheck/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always

[Install]
WantedBy=multi-user.target
```

`deploy/nginx.conf`, installed as `/etc/nginx/conf.d/spellcheck.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=suggest:10m rate=10r/s;
proxy_cache_path /var/cache/nginx/suggest levels=1:2 keys_zone=suggest_cache:10m max_size=100m inactive=1d use_temp_path=off;

server {
    listen 80;
    server_name spell.example.com;

    root /var/www/spellcheck/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # Filter: the manifest is always revalidated, the hashed file is cached for a year.
    location = /bloom/manifest.json {
        add_header Cache-Control "no-cache";
    }
    location ~ ^/bloom/bloom\.[0-9a-f]+\.bin$ {
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Vite's hashed bundles.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Suggestions: rate-limited, cached, proxied to FastAPI on localhost.
    location /api/ {
        limit_req zone=suggest burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache suggest_cache;
        proxy_cache_key "$uri$is_args$args";
        proxy_cache_valid 200 1d;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

```bash
sudo mkdir -p /var/cache/nginx/suggest && sudo chown www-data /var/cache/nginx/suggest
sudo cp deploy/spellcheck.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now spellcheck
sudo cp deploy/nginx.conf /etc/nginx/conf.d/spellcheck.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d spell.example.com
```

The user name `www-data` is the Ubuntu default. On Amazon Linux, nginx runs as `nginx`, so use that name in the cache directory command and in the unit file.

Smoke test after deploying:

```bash
curl -I https://spell.example.com/bloom/manifest.json
curl 'https://spell.example.com/api/suggest?word=recieve'
```

## Testing plan

Five automated checks cover the failure modes that matter, and the one most likely to bite silently is Python and JavaScript computing different bit positions.

| Check | How | Passes when |
| --- | --- | --- |
| No false negatives | `build.py` asserts every dictionary word passes the filter | The build finishes. It aborts otherwise. |
| False-positive rate | `build.py` prints measured vs expected on 200,000 random non-words | Measured is within about 30% of expected (about 0.038% at the defaults). |
| Python and JS agree | `npm test` replays `golden.json` | Every probe position and every membership result is equal. |
| Suggestion quality | `pytest` runs a list of known typos | The intended word is in the top 8. |
| Latency | `pytest` times uncached lookups | The 95th percentile stays under 50 ms (a target). Re-measure through nginx on the instance. |

Frontend tests, run with `npx vitest run` from `frontend/` (add `"test": "vitest run"` to `package.json`):

```ts
// src/bloom.test.ts
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import xxhash from "xxhash-wasm";
import golden from "../tests/golden.json";
import { parseBloom, positions, type H32 } from "./bloom";

let h32: H32;
beforeAll(async () => {
  h32 = (await xxhash()).h32Raw;
});

it("computes the same probe positions as Python", () => {
  for (const c of golden.cases) {
    expect(positions(h32, c.word, golden.k, golden.mask, golden.seed1, golden.seed2), c.word).toEqual(c.positions);
  }
});

it("answers membership like Python", () => {
  const manifest = JSON.parse(readFileSync("public/bloom/manifest.json", "utf8"));
  const file = readFileSync(`public/bloom/${manifest.file}`);
  const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const bloom = parseBloom(buf, h32);
  for (const c of golden.cases) expect(bloom.has(c.word), c.word).toBe(c.present);
});
```

Backend tests, run with `python -m pytest` from `backend/`:

```python
# backend/tests/test_suggest.py
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app, suggest_words

client = TestClient(app)

TYPOS = [
    ("teh", "the"),
    ("recieve", "receive"),
    ("definately", "definitely"),
    ("speling", "spelling"),
    ("seperate", "separate"),
    ("wierd", "weird"),
]


def terms(word: str) -> list[str]:
    r = client.get("/api/suggest", params={"word": word})
    assert r.status_code == 200
    return [s["term"] for s in r.json()["suggestions"]]


@pytest.mark.parametrize("typo,expected", TYPOS)
def test_expected_word_in_top_8(typo, expected):
    assert expected in terms(typo)


def test_nonsense_gets_nothing():
    assert terms("xqzvt") == []


def test_at_most_8():
    assert len(terms("tha")) <= 8


def test_p95_latency():
    samples = []
    for typo, _ in TYPOS * 20:
        suggest_words.cache_clear()  # time real lookups, not cache hits
        t0 = time.perf_counter()
        terms(typo)
        samples.append(time.perf_counter() - t0)
    samples.sort()
    assert samples[int(len(samples) * 0.95)] < 0.05
```

Extend `TYPOS` with 50 or more real typos from your own writing. The latency test repeats a small set, so a bigger list gives a more honest number.

By hand in the browser:

- Type “teh”. There is no underline until you type a space, then it appears.
- Right-click the word. The popup shows suggestions, and typing “Teh” offers “The”.
- Paste 10,000 words. The page stays responsive.
- Stop the backend. Underlines still work, and the popup says “No suggestions”.

## Hardening, pitfalls and final checklist

The word list matters more than any tuning here, because a filter can only be as good as the words in it.

- **Word list coverage.** A list of base forms flags “running” and “cats”, and a list without contractions flags “don't”. Check your JSON for inflections and contractions, and add what is missing before building.
- **Custom words.** To let users keep names and jargon, store an ignore set in `localStorage` and make `isOk` return true for those words. The filter file never changes.
- **Updating the filter.** Upload the new `bloom.<tag>.bin` first and `manifest.json` last. A client that still holds the old manifest finds the previous file, because the build keeps two versions.
- **Deploy the pair together.** The filter and `freq.txt` must come from the same `build.py` run. Otherwise the server could suggest a word the filter rejects.
- **Privacy in logs.** nginx logs query strings, so flagged words appear in the access log. Add `access_log off;` to the `/api/` block if that matters to you.
- **Abuse limits.** The defaults are 10 requests per second per IP with a burst of 20, and words over 40 characters are rejected. Tighten both if the API is public.
- **Memory.** Measure the backend's process memory after it loads `freq.txt`. It is the main sizing risk on a small instance.
- **Filter limits.** A Bloom filter cannot list or remove words. Growing the dictionary means re-running the build, which is a single script.

Final checklist:

- [ ] `words.json` checked for inflections and contractions
- [ ] `build.py` run, and the measured false-positive rate is close to the expected one
- [ ] `npm test` and `python -m pytest` pass
- [ ] Backend memory measured on the target instance
- [ ] Site and backend copied, service running, nginx reloaded
- [ ] HTTPS issued, and only ports 80 and 443 open
- [ ] Smoke test and the by-hand browser checks done
