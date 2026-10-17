import json
from pathlib import Path
import pickle
from xxhash import xxh32_intdigest
import math 
import sys

words_dictionary_bin_path = 'words_dictionary_bloom.bin'
words_dictionary_path = 'words_dictionary.json'
extra_hash_seed = 0xCAFEBABE


def get_hash_indices(word: str, k: int, m: int):
    word_bytes = word.encode('utf-8')
    h1 = xxh32_intdigest(word_bytes)
    indices = []
    for i in range(k):
        h2 = xxh32_intdigest(f"{word}{i}{extra_hash_seed}".encode('utf-8'))
        indices.append((h1 + i * h2) % m)
    return indices


def createBloomFilter(data_path: Path):
    try:
        with open(data_path, 'r') as f:
            data = json.load(f)
        if type(data) != dict or len(data) == 0:
            raise Exception("Invalid words dictionary")

        n = len(data)
        p = 0.01
        m = int((-n * math.log(p) / (math.log(2))**2))
        k = int((m / n * math.log(2)))
        bloom_filter = [0] * m
        for word in data:
            for index in get_hash_indices(word, k, m):
                bloom_filter[index] = 1
        with open(data_path.parent / words_dictionary_bin_path, 'wb') as f:
            pickle.dump(bloom_filter, f)
        return n, p, k, m

    except Exception as e:
        print(e)
        sys.exit(1)


def bloomFilterStartUp():
    try:
        base_dir = Path(__file__).resolve().parent
        wd_bin_path = base_dir / words_dictionary_bin_path
        wd_path = base_dir / words_dictionary_path
        if not wd_path.exists():
            raise Exception("Words dictionary json file not found")
        else:
            if not wd_bin_path.exists():
                print("Creating Bloom filter from dictionary...")
                capacity, false_positive_probability, no_of_hash_functions, bloom_fliter_size = createBloomFilter(wd_path)
                print(f"Bloom filter created successfully: capacity={capacity}, p={false_positive_probability}, k={no_of_hash_functions}, size={bloom_fliter_size}")
                return capacity, false_positive_probability, no_of_hash_functions, bloom_fliter_size
            else:
                with open(wd_bin_path, 'rb') as f:
                    bloom_filter = pickle.load(f)
                if type(bloom_filter) != list or len(bloom_filter) == 0:
                    raise Exception("Invalid bloom filter")
                print(f"Bloom filter loaded successfully ({len(bloom_filter)} bits).")
                return bloom_filter

    except Exception as e:
        print(e)
        sys.exit(1)


if __name__ == "__main__":
    bloomFilterStartUp()