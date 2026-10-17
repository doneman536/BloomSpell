import json
import math
import re
import struct
import unicodedata
from pathlib import Path
import symspellpy
import xxhash

SEED1 = 0x9E3779B1          # 2654435761
SEED2 = 0x85EBCA77          # 2246822519
EXTRA_HASH_SEED = 0xCAFEBABE  # 3405691582
MAGIC = b"SPBF"
HEADER = struct.Struct("<4sBBBBIII")  # magic(4), format(1), k(1), log2m(1), reserved(1), seed1(4), seed2(4), n(4) = 20 bytes
WORD_RE = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")

BASE_DIR = Path(__file__).resolve().parent
WORDS_JSON_PATH = BASE_DIR / "words_dictionary.json"
BLOOM_DIR = BASE_DIR / "bloom"
BLOOM_BIN_PATH = BLOOM_DIR / "bloom.bin"
MANIFEST_PATH = BLOOM_DIR / "manifest.json"
GOLDEN_PATH = BLOOM_DIR / "golden.json"
FREQ_PATH = BASE_DIR / "freq.txt"


def normalize(word: str) -> str:
    return unicodedata.normalize("NFC", word).replace("\u2019", "'").strip().lower()


def get_hash_indices(word: str, k: int, mask: int, seed1: int = SEED1, seed2: int = SEED2) -> list[int]:
    """Double-hashing: Kirsch-Mitzenmacher optimization using xxHash32."""
    data = word.encode("utf-8")
    h1 = xxhash.xxh32_intdigest(data, seed1)
    h2 = xxhash.xxh32_intdigest(data, seed2) | 1  # Force odd for full cycle coverage
    return [((h1 + i * h2) & mask) for i in range(k)]


def contains(bits: bytes, word: str, k: int, mask: int, seed1: int = SEED1, seed2: int = SEED2) -> bool:
    indices = get_hash_indices(word, k, mask, seed1, seed2)
    return all((bits[p >> 3] & (1 << (p & 7))) != 0 for p in indices)


def create_frequency_dictionary(words_set: set[str], out_path: Path):
    """Creates freq.txt merging bundled SymSpell English frequencies with dictionary words."""
    sym_dir = Path(symspellpy.__file__).parent
    bundled_freq = sym_dir / "frequency_dictionary_en_82_765.txt"
    freq_map: dict[str, int] = {}

    if bundled_freq.exists():
        with open(bundled_freq, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 2:
                    w, c = parts[0].lower(), int(parts[1])
                    freq_map[w] = c

    # Add any dictionary words with baseline frequency of 1
    for w in words_set:
        if w not in freq_map:
            freq_map[w] = 1

    # Sort descending by frequency count
    sorted_words = sorted(freq_map.items(), key=lambda x: -x[1])
    with open(out_path, "w", encoding="utf-8") as f:
        for w, c in sorted_words:
            f.write(f"{w} {c}\n")
    print(f"Frequency dictionary written to {out_path} ({len(sorted_words):,} words)")


def createBloomFilter(data_path: Path):
    print(f"Reading words from {data_path}...")
    with open(data_path, "r", encoding="utf-8") as f:
        raw_data = json.load(f)

    words = []
    ## consider only normalized words 
    for key in raw_data.keys():
        w = normalize(key)
        if WORD_RE.match(w):
            words.append(w)

    words = sorted(set(words))
    n = len(words)
    p_target = 0.01

    # bloom filter metrics
    ideal_m = -n * math.log(p_target) / (math.log(2) ** 2)
    log2m = max(10, math.ceil(math.log2(ideal_m)))  
    m = 1 << log2m
    mask = m - 1
    k = max(1, min(7, round((m / n) * math.log(2))))
    fp_expected = (1 - math.exp(-k * n / m)) ** k

    print(f"Building Bloom Filter: n={n:,}, m={m:,} bits (2^{log2m}), k={k}, expected FP={fp_expected:.4%}")

    # space optimization using the bytearray instead of list
    bits = bytearray(m // 8)
    for word in words:
        for pos in get_hash_indices(word, k, mask, SEED1, SEED2):
            bits[pos >> 3] |= 1 << (pos & 7)

    bits_bytes = bytes(bits)

    # Sanity verify: zero false negatives
    sample_check = words[:: max(1, n // 500)]
    assert all(contains(bits_bytes, w, k, mask, SEED1, SEED2) for w in sample_check), "Error: false negative detected!"

    BLOOM_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Write binary bloom filter file with 20-byte header
    header = HEADER.pack(MAGIC, 1, k, log2m, 0, SEED1, SEED2, n)
    blob = header + bits_bytes
    BLOOM_BIN_PATH.write_bytes(blob)
    print(f"Bloom filter binary written to {BLOOM_BIN_PATH} ({len(blob):,} bytes, ~{len(blob)/1024/1024:.2f} MiB)")

    # 2. manifest.json
    manifest = {
        "file": "bloom.bin",
        "bytes": len(blob),
        "k": k,
        "log2m": log2m,
        "m": m,
        "n": n,
        "seed1": SEED1,
        "seed2": SEED2,
        "extra_hash_seed": EXTRA_HASH_SEED,
        "expected_fp": fp_expected,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Manifest written to {MANIFEST_PATH}")

    # 3. golden.json test fixture
    known_set = set(words)
    present_samples = words[:: max(1, n // 20)][:20]
    absent_samples = [w for w in ("teh", "recieve", "speling", "definately", "xqzvt", "unvalidwordxyz") if w not in known_set]
    test_words = present_samples + absent_samples

    cases = [
        {
            "word": w,
            "positions": get_hash_indices(w, k, mask, SEED1, SEED2),
            "present": contains(bits_bytes, w, k, mask, SEED1, SEED2),
        }
        for w in test_words
    ]

    golden_data = {
        "k": k,
        "mask": mask,
        "seed1": SEED1,
        "seed2": SEED2,
        "extra_hash_seed": EXTRA_HASH_SEED,
        "cases": cases,
    }
    GOLDEN_PATH.write_text(json.dumps(golden_data, indent=2), encoding="utf-8")
    print(f"Golden vectors written to {GOLDEN_PATH}")

    # 4. Generate frequency dictionary for SymSpell
    create_frequency_dictionary(known_set, FREQ_PATH)

    return manifest


def bloomFilterStartUp():
    if not BLOOM_BIN_PATH.exists() or not MANIFEST_PATH.exists() or not FREQ_PATH.exists():
        print("Bloom filter or frequency files missing. Generating now...")
        return createBloomFilter(WORDS_JSON_PATH)
    else:
        print(f"Bloom filter files exist in {BLOOM_DIR}.")
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        return manifest


if __name__ == "__main__":
    createBloomFilter(WORDS_JSON_PATH)