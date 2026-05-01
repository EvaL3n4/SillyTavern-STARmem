# Changelog

All notable changes to STARmem are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0; STARmem
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.5]—2026-05-01

Patch release. Honest trace labels for swipe / continue / regenerate.

### Added

- **Cause badge in the Memory Viewer Traces tab.** Retrieval traces
  now carry a `cause` field threaded through from SillyTavern's
  `runGenerationInterceptors(chat, contextSize, type)` call. The
  Traces tab renders a small italic chip alongside the tier badge for
  non-normal causes — `swipe`, `continue`, `regen` (regenerate),
  `impersonate`, `quiet` — so consecutive same-query traces from
  rerolls/continuations read as honest "same retrieval, different
  generation" instead of being misread as the working buffer
  re-growing. Normal turns get no chip; the common case stays
  visually quiet. Hover tooltip exposes the raw cause string for
  power users. Legacy traces (pre-2.0.5) without a `cause` field
  render without crashing and without spurious badges.

## [2.0.4]—2026-05-01

Patch release. Stop capturing model chain-of-thought as memory.

### Fixed

- **Reasoning/CoT blocks are stripped before working entries are stored.**
  When SillyTavern's reasoning template (`<think>…</think>` by default,
  or any custom prefix/suffix configured in user settings) appears
  inline in an assistant reply, STARmem now asks ST's own
  `parseReasoningFromString` to remove it before pushing the entry into
  the working buffer. Previously, the model's chain-of-thought leaked
  into memory and could surface in retrieval. The fix is
  template-aware (honours custom CoT markers, not just `<think>`),
  order-independent (works whether STARmem or ST's reasoning auto-parser
  wins the `MESSAGE_RECEIVED` listener race), and `auto_parse`-agnostic.
  When the message is *only* a reasoning block (empty after strip), the
  entry is skipped entirely. Falls back to the raw `mes` if the parser
  is missing (older ST builds) or throws.

## [2.0.3]—2026-04-30

Patch release. Reroll/swipe protection: rejected draft generations no
longer pollute long-term memory.

### Fixed

- **Swipes (rerolls) now scrub the working buffer.** When the user
  swipes a message to a different variant, every working-buffer entry
  whose provenance references that message is evicted before the next
  consolidation pass. Previously, every reroll variant accumulated as a
  separate working entry; if the buffer crossed the consolidation
  threshold mid-rerolling, all rejected drafts could graduate to
  long-term episodic memory alongside the variant the user actually
  kept. Already-consolidated entries are deliberately left untouched —
  graduated facts are user-owned and will be deletable via the
  forthcoming memory-management UI, not via swipe side effects.
- **Idle timer resets on swipe.** Swiping is user activity, not
  idleness; the 60s idle-consolidation countdown now restarts on
  MESSAGE_SWIPED so consolidation does not fire on a user mid-reroll.

### Documentation

- **Spec §8.1 added: Chat-Lifecycle Hooks and the Deletion Contract.**
  Codifies which lifecycle events may scrub working-buffer entries
  (MESSAGE_DELETED, MESSAGE_SWIPED) and explicitly forbids retroactive
  surgery on graduated entries, preserving §6.3's "consolidate() is
  the only function that mutates long-term storage" invariant.

## [2.0.2]—2026-04-30

Patch release. Settings panel collapses into ST's standard inline-drawer
chrome instead of taking up persistent space.

### Changed

- **Settings panel is now a collapsible drawer.** STARmem's settings panel
  in the Extensions tab now lives inside SillyTavern's standard
  `inline-drawer` markup (header + collapsible content), matching the
  convention used by Vector Storage, Summarize, Quick Reply, and other
  built-in extensions. The panel collapses by default; click the
  "STARmem" header to open it. Card chrome (border, shadow, padding)
  removed since the drawer carries it.

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
