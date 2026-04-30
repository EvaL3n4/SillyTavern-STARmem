# Changelog

All notable changes to STARmem are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0; STARmem
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1]—2026-04-30

Patch release. Native ST prompt injection, working-buffer fix, viewer
polish.

### Changed

- **Injection switched to `setExtensionPrompt`**—STARmem now registers
  its memory fragment via SillyTavern's prompt manager
  (`IN_CHAT`, depth 4, system role) instead of splicing a synthetic
  message into `chat`. No more chat-array mutation; cache and recency
  behavior unchanged.
- **Memory Viewer header** shortened from "STARmem Memory Viewer" to
  "Memory Viewer".
- **Memory Viewer rows** gain breathing room and de-emphasize the
  importance/recency meta line so subject and content lead the eye.

### Fixed

- **Working buffer no longer re-ingests greetings on chat load.**
  SillyTavern re-emits `MESSAGE_RECEIVED` with `type='first_message'`
  whenever a chat is opened or the renderer rehydrates; the bootstrap
  hook now skips that replay so character-card greetings stop being
  captured as generated content.

## [2.0.0]—2026-04-30

First public release. Clean break from the v1 private beta—not
migrated; new chats only.

### Architecture

- **Single-substrate context tree** in `chatMetadata['STARmem']`. No
  sidecar files; no vector DB; no embeddings.
- **Three memory scopes**: Working (hot buffer), Episodic (long-term),
  Persona (Enhanced-RAPTOR-distilled). Graph is infrastructure.
- **Deterministic 4-tier retrieval ladder**: T0 exact cache → T1 fuzzy
  cache → T3 intent-routed graph expansion (BM25-seeded) → Floor
  (recency × importance × maturity_boost). No LLM on the query path.
- **Single write path**—one `consolidate()` function, lazy-chained
  (buffer ≥ 10 or idle ≥ 60s).
- **AKL-lite lifecycle**—importance (0–100), maturity tiers with
  hysteresis gaps, recency decay (τ = 30d), multiplicative score.

### Surface

- **Memory Viewer**—tabbed dashboard (Working / Episodic / Persona /
  Graph / Traces) with subject filter, JSONL trace export, ARIA +
  keyboard navigation, and the "Quiet Library" visual identity.
- **Settings panel**—buffer size, idle timeout, connection profile
  selection (extraction model picker via ST's connection manager).
- **Consolidation indicator**—subtle pulse next to the send button
  while consolidation runs.
- **Interceptor**—installs into ST's
  `globalThis.SillyTavern.extensions`, injects retrieved memories into
  the prompt at chat-completion time.

### Benchmarking

- **First-class harness**—`bench/cli.js` with corpus adapters for
  LoCoMo and LongMemEval-S (6 task types).
- **Modal-served sweep substrate**—`--mode run-point | run-baselines |
  run-sweep` with per-corpus parameter sweeps and conversation-level
  parallel fan-out (`run_point_chunk`, 30-container parallelism).
- **Coverage-aware amendment gate**—`_should_amend(baseline,
  candidate)` enforces `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp` before
  merging parameter tuning.
- **Honest baselines**—bm25only / recency / random retrievers on both
  corpora, documented in `docs/bench/baselines/*.md`.

### Test substrate

- 105 jest suites / 1010 unit + integration tests
- Pytest coverage for benchmark / Modal infrastructure
- 10+ Playwright E2E tests against a live local ST
- Three CSS-hygiene invariants (`no-leaky-css`,
  `style-css-invariants`, `no-hardcoded-colors`) gating UI work
- Token-defined invariant test pinning the design system

### Out of scope (per spec §11)

Not in v2.0: drift detection; influence propagation at retrieval time;
multi-agent research loops; embeddings; v1 migration; setup wizard;
health checks; debug console; lightweight NER (capitalized-word
matching suffices). These remain v2.1+ candidates.

### Acknowledgements

STARmem v2 was built across 16 phases over ~6 weeks. Thanks to the
ByteRover, AdaMem, MAGMA, and Enhanced RAPTOR teams whose papers
shaped the architecture; to RivelleDays' MoonlitEchoes for the
extension-install convention reference; and to the SillyTavern team
for an extension surface that survives a clean substrate replacement
without API churn.
