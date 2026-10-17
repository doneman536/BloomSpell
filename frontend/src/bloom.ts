import xxhash from "xxhash-wasm";

export type H32 = (data: Uint8Array, seed?: number) => number;

export interface BloomManifest {
  file: string;
  bytes: number;
  k: number;
  log2m: number;
  m: number;
  n: number;
  seed1: number;
  seed2: number;
  extra_hash_seed: number;
  expected_fp: number;
}

export interface Bloom {
  has(word: string): boolean;
  k: number;
  n: number;
  log2m: number;
  m: number;
  seed1: number;
  seed2: number;
  extra_hash_seed: number;
  positions(word: string): number[];
}

const encoder = new TextEncoder();

export function positions(
  h32: H32,
  word: string,
  k: number,
  mask: number,
  seed1: number,
  seed2: number
): number[] {
  const data = encoder.encode(word);
  const h1 = h32(data, seed1) >>> 0;
  const h2 = (h32(data, seed2) | 1) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    out.push(((h1 + Math.imul(i, h2)) >>> 0) & mask);
  }
  return out;
}

export function parseBloom(buf: ArrayBuffer, h32: H32, manifest?: BloomManifest): Bloom {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SPBF" || dv.getUint8(4) !== 1) {
    throw new Error("Unsupported Bloom filter file format (expected SPBF v1)");
  }

  const k = dv.getUint8(5);
  const log2m = dv.getUint8(6);
  const seed1 = dv.getUint32(8, true);
  const seed2 = dv.getUint32(12, true);
  const n = dv.getUint32(16, true);
  const extra_hash_seed = manifest?.extra_hash_seed ?? 0xcafebabe;

  if (log2m < 3 || log2m > 30) {
    throw new Error(`Invalid Bloom filter size exponent: ${log2m}`);
  }

  const expectedBytes = 2 ** (log2m - 3);
  const bits = new Uint8Array(buf, 20);
  if (bits.length !== expectedBytes) {
    throw new Error(`Filter file size mismatch: expected ${expectedBytes} bit-bytes, got ${bits.length}`);
  }

  const m = 2 ** log2m;
  const mask = m - 1;

  return {
    k,
    n,
    log2m,
    m,
    seed1,
    seed2,
    extra_hash_seed,
    positions: (word: string) => positions(h32, word, k, mask, seed1, seed2),
    has: (word: string) => {
      const probePositions = positions(h32, word, k, mask, seed1, seed2);
      return probePositions.every((p) => (bits[p >> 3] & (1 << (p & 7))) !== 0);
    },
  };
}

export async function loadBloom(base = "/bloom"): Promise<{ bloom: Bloom; manifest: BloomManifest }> {
  const [{ h32Raw }, manifestRes] = await Promise.all([
    xxhash(),
    fetch(`${base}/manifest.json`, { cache: "no-cache" }),
  ]);

  if (!manifestRes.ok) {
    throw new Error(`Failed to load manifest.json: HTTP ${manifestRes.status}`);
  }

  const manifest: BloomManifest = await manifestRes.json();
  const binaryRes = await fetch(`${base}/${manifest.file || "bloom.bin"}`);
  if (!binaryRes.ok) {
    throw new Error(`Failed to load filter binary ${manifest.file}: HTTP ${binaryRes.status}`);
  }

  const buf = await binaryRes.arrayBuffer();
  const bloom = parseBloom(buf, h32Raw, manifest);

  return { bloom, manifest };
}
