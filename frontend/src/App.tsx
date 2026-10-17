import { useEffect, useState } from "react";
import { loadBloom, type Bloom, type BloomManifest } from "./bloom";
import { Editor } from "./Editor";
import {
  Sparkles,
  Zap,
  CheckCircle2,
  AlertCircle,
  Hash,
  Database,
  Cpu,
  RefreshCw,
  Search,
} from "lucide-react";

export default function App() {
  const [bloom, setBloom] = useState<Bloom | null>(null);
  const [manifest, setManifest] = useState<BloomManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [stats, setStats] = useState({ words: 0, chars: 0, typos: 0 });
  const [testWord, setTestWord] = useState<string>("recieve");

  useEffect(() => {
    loadBloom()
      .then(({ bloom, manifest }) => {
        setBloom(bloom);
        setManifest(manifest);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load bloom filter:", err);
        setError(String(err.message || err));
        setLoading(false);
      });
  }, []);

  const handleInspectWord = (word: string) => {
    if (!bloom) return null;
    const normalized = word.trim().toLowerCase();
    const positions = bloom.positions(normalized);
    const isPresent = bloom.has(normalized);
    return { word: normalized, positions, isPresent };
  };

  const inspected = testWord && bloom ? handleInspectWord(testWord) : null;

  return (
    <div className="app-container">
      {/* Top Navigation / Branding */}
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon">
            <Sparkles className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="brand-text">
            <h1>BloomSpell</h1>
            <span className="brand-subtitle">
              Sub-Microsecond In-Browser Bloom Filter & SymSpell Engine
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-content">
        {loading && (
          <div className="state-card loading">
            <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
            <h3>Loading Bloom Filter Binary…</h3>
            <p>Fetching 512 KiB packed bit-array & initializing WebAssembly xxHash</p>
          </div>
        )}

        {error && (
          <div className="state-card error">
            <AlertCircle className="w-8 h-8 text-rose-400" />
            <h3>Dictionary Load Error</h3>
            <p>{error}</p>
          </div>
        )}

        {!loading && bloom && manifest && (
          <>
            {/* System Performance & Metadata Bar */}
            <section className="metadata-grid">
              <div className="meta-card">
                <div className="meta-icon">
                  <Database className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="meta-info">
                  <span className="meta-label">Total Words</span>
                  <span className="meta-value">{manifest.n.toLocaleString()}</span>
                </div>
              </div>

              <div className="meta-card">
                <div className="meta-icon">
                  <Cpu className="w-4 h-4 text-sky-400" />
                </div>
                <div className="meta-info">
                  <span className="meta-label">Filter Size</span>
                  <span className="meta-value">
                    {(manifest.bytes / 1024).toFixed(0)} KiB ({(manifest.m / 1024 / 1024).toFixed(1)}M bits)
                  </span>
                </div>
              </div>

              <div className="meta-card">
                <div className="meta-icon">
                  <Hash className="w-4 h-4 text-violet-400" />
                </div>
                <div className="meta-info">
                  <span className="meta-label">Probes & FP Rate</span>
                  <span className="meta-value">
                    k = {manifest.k} ({(manifest.expected_fp * 100).toFixed(2)}%)
                  </span>
                </div>
              </div>

              <div className="meta-card">
                <div className="meta-icon">
                  <Zap className="w-4 h-4 text-amber-400" />
                </div>
                <div className="meta-info">
                  <span className="meta-label">Lookup Latency</span>
                  <span className="meta-value">&lt; 20 ns (Client-Side)</span>
                </div>
              </div>
            </section>

            {/* Editor & Live Inspector Grid */}
            <div className="workspace-layout">
              {/* Primary Editor Pane */}
              <div className="editor-pane">
                <Editor bloom={bloom} onStatsChange={setStats} />

                {/* Editor Stats Footer */}
                <div className="editor-footer-stats">
                  <div className="stat-group">
                    <span className="stat-label">Words:</span>
                    <span className="stat-val">{stats.words}</span>
                  </div>
                  <div className="stat-group">
                    <span className="stat-label">Characters:</span>
                    <span className="stat-val">{stats.chars}</span>
                  </div>
                  <div className="stat-group typo-badge">
                    <span className="stat-label">Misspellings Detected:</span>
                    <span className={`stat-val ${stats.typos > 0 ? "has-typos" : ""}`}>
                      {stats.typos}
                    </span>
                  </div>
                </div>
              </div>

              {/* Sidebar: Bit Probe & Seed Inspector */}
              <aside className="inspector-sidebar">
                <div className="inspector-card">
                  <div className="inspector-card-header">
                    <Search className="w-4 h-4 text-indigo-400" />
                    <h3>Probe Inspector</h3>
                  </div>
                  <p className="inspector-desc">
                    Test any word to inspect its 7 bit positions computed via xxHash32:
                  </p>

                  <div className="inspector-input-box">
                    <input
                      type="text"
                      value={testWord}
                      onChange={(e) => setTestWord(e.target.value)}
                      placeholder="Type a word..."
                      className="inspector-input"
                    />
                  </div>

                  {inspected && (
                    <div className="inspector-results">
                      <div className="result-status">
                        <span className="result-label">Status:</span>
                        {inspected.isPresent ? (
                          <span className="result-badge valid">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Valid Dictionary Word
                          </span>
                        ) : (
                          <span className="result-badge invalid">
                            <AlertCircle className="w-3.5 h-3.5" /> Misspelled / Not Found
                          </span>
                        )}
                      </div>

                      <div className="probe-positions-title">
                        <span>Bit Probe Positions (k = {manifest.k}):</span>
                      </div>
                      <div className="probe-positions-list">
                        {inspected.positions.map((pos, i) => (
                          <div key={i} className="probe-position-pill">
                            <span className="probe-idx">p{i}:</span>
                            <span className="probe-num">{pos.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="inspector-card seeds-card">
                  <div className="inspector-card-header">
                    <Hash className="w-4 h-4 text-emerald-400" />
                    <h3>Manifest & Seeds</h3>
                  </div>
                  <div className="seed-rows">
                    <div className="seed-row">
                      <span className="seed-label">seed1:</span>
                      <code>0x{manifest.seed1.toString(16).toUpperCase()}</code>
                    </div>
                    <div className="seed-row">
                      <span className="seed-label">seed2:</span>
                      <code>0x{manifest.seed2.toString(16).toUpperCase()}</code>
                    </div>
                    <div className="seed-row">
                      <span className="seed-label">extra_hash_seed:</span>
                      <code>0x{manifest.extra_hash_seed.toString(16).toUpperCase()}</code>
                    </div>
                    <div className="seed-row">
                      <span className="seed-label">format:</span>
                      <code>SPBF v1 (No Versioning)</code>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
