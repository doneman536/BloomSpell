import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from symspellpy import SymSpell
import Path
from startUpScript import bloomFilterStartUp


words_dictionary_bin_path = 'words_dictionary_bloom.bin'

app = FastAPI(
    title="SC Backend Service",
    description="FastAPI service with xxHash and SymSpell support",
    version="1.0.0",
)

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize SymSpell instance
sym_spell = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)


@app.get("/health")
def read_root():
    return {
        "status": "online",
        "message": "FastAPI server is running on port 3035 for spelling checker.",
    }

@app.get("/suggestions?q={query}")
def get_suggestions(query: str):
    if bloom_filter[query]:
        return {
            "query": query,
            "suggestions": sym_spell.candidates(query, max_edit_distance=2),
        }
    return {
        "query": query,
        "suggestions": sym_spell.candidates(query, max_edit_distance=2),
    }


if __name__ == "__main__":
    port = int(os.getenv("PORT", 3035))
    base_dir = Path(__file__).resolve().parent
    wd_bin_path = base_dir / words_dictionary_bin_path
    if not wd_bin_path.exists():
        bloomFilterStartUp()
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
