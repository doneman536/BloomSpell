import os
import re
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from symspellpy import SymSpell, Verbosity
import uvicorn

from startUpScript import bloomFilterStartUp

BASE_DIR = Path(__file__).resolve().parent
BLOOM_DIR = BASE_DIR / "bloom"
FREQ_FILE = BASE_DIR / "freq.txt"
WORD_RE = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")
MAX_SUGGESTIONS = 8


manifest = bloomFilterStartUp()

app = FastAPI(
    title="SC Bloom Filter Spell Checker",
    description="FastAPI service with xxHash Bloom Filter and SymSpell suggestions",
    version="1.0.0",
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve bloom filter binary and manifest statically
app.mount("/bloom", StaticFiles(directory=str(BLOOM_DIR)), name="bloom")

# SymSpell with the generated frequency list
sym_spell = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
if not sym_spell.load_dictionary(str(FREQ_FILE), term_index=0, count_index=1, separator=" "):
    raise RuntimeError(f"Could not load frequency dictionary from {FREQ_FILE}")
print(f"SymSpell loaded successfully with {len(sym_spell.words):,} words.")


@lru_cache(maxsize=50_000)
def get_symspell_suggestions(word: str) -> list[dict]:
    # Look for distance 1 first
    items = sym_spell.lookup(word, Verbosity.ALL, max_edit_distance=1)
    # If fewer than max and word is long enough, expand to distance 2
    if len(items) < MAX_SUGGESTIONS and len(word) > 4:
        items = sym_spell.lookup(word, Verbosity.ALL, max_edit_distance=2)

    return [{"term": s.term, "distance": s.distance, "count": s.count} for s in items[:MAX_SUGGESTIONS]]


@app.get("/health")
@app.get("/api/health")
def health_check():
    return {
        "status": "online",
        "bloom_info": manifest,
    }


@app.get("/api/suggest")
@app.get("/suggestions")
def get_suggestions(
    response: Response,
    word: str = Query(None, min_length=1, max_length=50),
    q: str = Query(None, min_length=1, max_length=50),
):
    query = (word or q or "").strip().lower().replace("\u2019", "'")
    response.headers["Cache-Control"] = "public, max-age=86400"

    if not query or not WORD_RE.match(query):
        return {"word": query, "suggestions": []}

    suggestions = get_symspell_suggestions(query)
    return {
        "word": query,
        "suggestions": suggestions,
    }


if __name__ == "__main__":
    port = int(os.getenv("PORT", 3035))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
