# BloomSpell: End-to-End Bloom Filter Spell Checker

A two-tier spell checking architecture combining **sub-microsecond client-side verification** via a compact binary Bloom filter with a **FastAPI + SymSpell suggestion engine**.

---

## ⚡ Overview & Architecture

Standard web spell checkers send every keystroke or word over the network to a remote server, introducing latency, server load, and privacy leaks. 

**BloomSpell splits the work into two distinct stages:**

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Browser (Client-Side)                           │
│                                                                        │
│  [User Types] ──► CodeMirror 6 ──► xxHash-WASM ──► 512 KiB Bloom Filter│
│                                                          │             │
│                                          Word Valid? ────┴───┐         │
│                                                              ▼         │
│                                                      [No Underline]    │
│                                                  (0 network requests)  │
│                                                                        │
│  [Right Click Underlined Typo]                                         │
│        │                                                               │
└────────┼───────────────────────────────────────────────────────────────┘
         │  HTTP GET /api/suggest?word=teh (Only on-demand)
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     FastAPI Server (Port 3035)                         │
│                                                                        │
│  SymSpell Engine ◄── freq.txt (Word Frequencies: 379k+ entries)        │
│        │                                                               │
│        └──► Returns top 8 ranked corrections:                          │
│             1. "the" (distance: 1, freq: 23,135,851,162)               │
│             2. "tech" (distance: 1, freq: 93,401,669)                  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Client-Side Bloom Filter (Port 3036):**
   - The browser downloads a compact binary filter (`bloom.bin`, ~512 KiB) **once** and keeps it in memory as a typed byte-array (`Uint8Array`).
   - Words are verified locally in **under 20 nanoseconds** using WebAssembly xxHash32.
   - Valid words are **never sent over the network** and produce zero server load.
   - Since a Bloom filter has **zero false negatives**, no valid dictionary word is ever incorrectly underlined.

2. **Backend Suggestion Engine (Port 3035):**
   - The server answers only the computationally heavier question: *"What did the user intend to type?"*
   - Only triggered when the user right-clicks a flagged word.
   - SymSpell inspects candidate words within 1–2 edits and ranks them using real English word frequencies (`freq.txt`).

---

## 📁 Key Files & Components

| File | Purpose |
| :--- | :--- |
| `sc-be/startUpScript.py` | Builds the packed binary filter (`bloom.bin`), `manifest.json`, `golden.json`, and `freq.txt` from `words_dictionary.json`. |
| `sc-be/bloom/bloom.bin` | Packed binary filter (~512 KiB) containing a 20-byte `SPBF` header followed by raw bit-bytes. |
| `sc-be/bloom/manifest.json` | Filter metadata including file size, probe count $k$, bit exponent $\log_2(m)$, expected false-positive rate, and hash seeds (`seed1`, `seed2`, `extra_hash_seed`). |
| `sc-be/bloom/golden.json` | Test fixture with pre-computed hash probe positions and presence results for cross-language verification between Python and JavaScript. |
| `sc-be/freq.txt` | Word frequency dictionary (379,346 words) used by SymSpell to rank suggestions by popularity. |
| `sc-be/server.py` | FastAPI backend service running on port 3035 providing `/api/suggest`, `/health`, and static `/bloom` hosting. |
| `frontend/` | React + TypeScript + CodeMirror 6 + `xxhash-wasm` frontend application running on port 3036. |

---

## 🔬 Mathematical Properties & Bit-Packing

### 1. Sizing Formulas
For $n = 370,100$ words and a target false positive rate $p = 0.01$:
* **Ideal bit size:** $m = \frac{-n \ln(p)}{(\ln 2)^2} \approx 3.55 \times 10^6\text{ bits}$
* **Power-of-two rounding:** $m = 2^{22} = 4,194,304\text{ bits}$ (allows ultra-fast bitwise masking `& (m - 1)` instead of modulo division).
* **Hash functions:** $k = \min\left(7, \text{round}\left(\frac{m}{n} \ln 2\right)\right) = 7$.
* **Actual False Positive Rate:** $\approx 0.44\%$ (less than 1 misspelling in 220 slips through).

### 2. Compact Binary Bit-Packing
Instead of storing integers or JSON arrays, 8 filter bits are packed into each byte:
$$\frac{4{,}194{,}304\text{ bits}}{8\text{ bits/byte}} = 524{,}288\text{ bytes} \approx \mathbf{512\text{ KiB}}$$

* **Byte Index:** `p >> 3` (equivalent to $\lfloor p / 8 \rfloor$).
* **Bit Offset:** `p & 7` (equivalent to $p \pmod 8$).
* **Write (Python):** `buffer[p >> 3] |= (1 << (p & 7))`
* **Read (Browser):** `(bits[p >> 3] & (1 << (p & 7))) !== 0`

### 3. Double-Hashing (Kirsch-Mitzenmacher)
Instead of executing $k$ expensive hash functions per word, two 32-bit hashes ($h_1$ and $h_2$) generate all $k$ probe positions:
$$p_i = (h_1 + i \cdot h_2) \ \& \ (m - 1), \quad h_2 \text{ odd}, \quad i = 0 \ldots k-1$$

---

## 🚀 Quickstart Guide

### 1. Backend Setup (`sc-be`)

```bash
cd sc-be

# Activate Python virtual environment
source sc-env/bin/activate

# Install dependencies (FastAPI, Uvicorn, xxHash, SymSpell)
pip install -r requirements.txt

# (Optional) Rebuild the Bloom filter and frequency assets
python startUpScript.py

# Start the FastAPI server on Port 3035
python server.py
```

The backend server runs at `http://localhost:3035`:
* **Health Check:** `http://localhost:3035/health`
* **Suggestion API:** `http://localhost:3035/api/suggest?word=teh`
* **Bloom Manifest:** `http://localhost:3035/bloom/manifest.json`
* **Filter Binary:** `http://localhost:3035/bloom/bloom.bin`

---

### 2. Frontend Setup (`frontend`)

```bash
cd frontend

# Install dependencies
npm install

# Start the Vite development server on Port 3036
npm run dev
```

Open your browser at **`http://localhost:3036`**.

---

## 💡 How It Works in Action

1. **Initialization:** On initial load, the frontend fetches `/bloom/manifest.json` and `/bloom/bloom.bin`. It initializes `xxhash-wasm` and maps the bit-array directly into WebAssembly memory.
2. **Real-Time Typing:** CodeMirror 6 tokenizes visible words. Valid words evaluate in nanoseconds with zero network activity.
3. **Non-Intrusive Underlines:** The word currently being typed is never flagged until you press space or move the caret away.
4. **Right-Click Suggestions:** Right-clicking any underlined word opens a context menu that queries `GET /api/suggest?word=...` from the FastAPI SymSpell backend.
5. **One-Click Replacement:** Selecting a correction immediately patches the document at the exact token range.
6. **Bit Probe Inspector:** The right-hand sidebar allows inspecting any word's individual 7 bit positions and testing dictionary membership in real time.