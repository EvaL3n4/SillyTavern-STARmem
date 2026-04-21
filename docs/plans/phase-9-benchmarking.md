# Phase 9 — Benchmarking Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ship a deterministic, replayable benchmarking subsystem for STARmem — corpus loader, retrieval-metrics library, harness CLI, coordinate-descent knob sweeps, and baseline comparisons — so every τ/λ/cap that currently carries a "guess from the planning conversation, Phase 9 tunes" marker gets a measured value.

**Architecture:** Read-only black-box evaluation against LoCoMo conversations. Harness seeds STARmem state from a conversation transcript, replays queries through the public retrieval ladder, dumps the existing trace JSONL, and computes precision@k / recall@k / MRR offline. Gold-match uses token-Jaccard against entry content (avoids forcing LoCoMo's QA format into STARmem's extraction shape). Knobs sweep via coordinate descent, one cluster at a time, each sweep's outputs written to `docs/bench/sweeps/YYYY-MM-DD-knob.md` with a concrete elbow recommendation.

**Tech Stack:** Node 20+ (same runtime as jest tests), vanilla ESM, no new dependencies. Synthetic embeddings for retrieval-path benchmarks (the path doesn't use them). Persona-rebuild benchmarks deferred to a sub-phase that requires real ST Vectors.

---

## Decisions locked before writing this plan (see 2026-04-21 session):

1. **Corpus: LoCoMo primary.** `snap-research/locomo` `data/locomo10.json` — 10 conversations, ~300 turns each, QA-annotated. LongMemEval as secondary if time permits. Synthetic corpus reserved for determinism smoke tests only.
2. **Metrics: precision@k, recall@k, MRR** at k ∈ {1, 3, 5, 10}, per tier and overall. Latency p50/p95 secondary. No F1 (retrieval cost is asymmetric).
3. **Harness shape: Node CLI under `bench/`** that consumes the existing trace JSONL export. Same pipeline runs offline (JSONL replay) and live (in-process). No new trace format.
4. **Black-box evaluation: Jaccard-based gold-match.** Query → top-K entry ids → match against gold answer by token-Jaccard ≥ 0.5 of entry content vs gold evidence span. Avoids translating LoCoMo facts into STARmem's subject/tags extraction shape.
5. **Baselines: in-house only.** Naive BM25-only (Tier-2-direct, no ladder), recency-only, random. No external systems (Zep/Mem0) — file as v2.1.
6. **Tuning protocol: coordinate descent.** Freeze the corpus, sweep one knob at a time, write sweep logs to `docs/bench/sweeps/`. Accept the value at the elbow of the recall/latency curve. No grid search.
7. **Embeddings: synthetic for retrieval-path benches.** Retrieval doesn't touch embeddings (spec §11). Persona-rebuild is the only user of embeddings, and its benchmarks are deferred to a sub-phase that spins up real ST Vectors.
8. **Regression gate: advisory-only for v2.0.** `docs/bench/baseline.json` per-knob snapshot. CI surfaces deltas but doesn't fail on them. Turn into a gate post-v2.0.
9. **Out of scope for Phase 9:** Playwright smoke harness (→ separate Phase 10 if we ship it). UX polish pass (→ pre-external-release). Persona-rebuild benchmarks (→ sub-phase 9.5 with real ST Vectors). External memory-system baselines.
10. **Spec §10 module layout amendment first.** Task 0 updates `docs/specs/` to reflect the two Phase 8 deviations (viewer sub-directory, integration barrel) and names `src/eval/` placeholder as `bench/` (external to src — non-runtime). Standalone `docs(spec)` commit before Task 1.

---

## Scope Recap → Verification Checklist

Per the Phase 8 retro lesson ("translate deliverables into explicit call-site checklists"), every ships-X bullet below has a matching verification bullet that names the call site.

**Ships (deliverables):**

- D1. `bench/loaders/locomo.js` — LoCoMo corpus loader + QA parser
- D2. `bench/metrics/retrieval.js` — precision@k, recall@k, MRR computations
- D3. `bench/runner.js` + `bench/cli.js` — harness orchestrator, JSONL output
- D4. `bench/sweeps/tau.js` — τ_confidence / τ_gap coordinate sweep
- D5. `bench/sweeps/graph.js` — λ₁ / λ₂ / beam / edge-cap sweep
- D6. `bench/sweeps/consolidation.js` — DEDUP_JACCARD / EXTRACT_MAX_TOKENS sweep
- D7. `bench/sweeps/bm25.js` — TAG_BOOST / SUBJECT_BOOST sweep
- D8. `bench/baselines/` — naive BM25 / recency / random baseline implementations
- D9. `docs/bench/baseline.json` + `docs/bench/sweeps/*.md` — measured values
- D10. `phase-9-retro.md` + ROADMAP retro append

**Verification (call-site checklist, enforced by Task 10):**

- V1. `bench/cli.js` imports and calls `loadLocomo` (D1)
- V2. `bench/cli.js` imports and calls `computeMetrics` (D2)
- V3. `bench/cli.js` imports and calls `runHarness` (D3)
- V4-V7. Each sweep script imports and calls `runHarness` + `computeMetrics`
- V8. Each baseline is importable from `bench/baselines/index.js` and exercised at least once by `bench/runner.js`
- V9. `docs/bench/baseline.json` exists and parses as JSON with at least one entry per swept knob
- V10. `docs/plans/phase-9-retro.md` exists, lists each Decision 1-10 with held/revised status

---

## Inter-Phase Notes (inherited from Phases 3-8)

Pulled from every "Notes for Phase 9" section in the ROADMAP. Each bullet below pins a knob this plan measures:

- **τ_confidence / τ_gap** (Phase 4). Opening values 2.0 / 0.5 — "conservative something-obvious-happened values." Expect substantial movement on real BM25 score distributions. Swept in Task 5.
- **λ₁ / λ₂** (Phase 5). Graph-vs-BM25 weighting, spec default 1.0 / 0.3. First thing to tune against LoCoMo. Swept in Task 6.
- **Beam width × hops** (Phase 5). 5 × 2 is an educated guess. Low recall@k → bump to 10, latency blow → drop to 3. Swept in Task 6.
- **Edge cap** (Phase 5). 20, from spec §12.2. Traces expose per-entry edge counts; cap binding on >20% of entries means it's too tight. Swept in Task 6.
- **Co-occurrence weight** (Phase 5). 0.5 vs explicit-relation 1.0. 2× ratio — widen if explicit outperforms heavily, narrow if both carry similar signal. Swept in Task 6.
- **DEDUP_JACCARD_THRESHOLD** (Phase 6). 0.7 opening. Watch `added:updated` ratio in consolidation traces. <10% updates = too strict, >50% = too lax. Swept in Task 7.
- **EXTRACT_MAX_TOKENS** (Phase 6). Guess. LLM hitting cap (response ends in `,` or `"...`) → bump. Responses always <500 → drop to save cost. Swept in Task 7 (read-only inspection, not tuned in-harness because it requires live LLM calls).
- **SUMMARY_MAX_TOKENS** (Phase 7). Persona-rebuild tunable. Deferred to sub-phase 9.5.
- **K_BASE / K_STEP / GAMMA_BASE** (Phase 7). Persona-rebuild kNN + Leiden γ. Deferred to 9.5.
- **TAG_BOOST / SUBJECT_BOOST** (Phase 3). Integer 2/2. Fractional support needs a tokenizer refactor — tune integer values in Task 8, file fractional as v2.1 if needed.

**Critical invariants that must NOT be tuned:**

- Tier 3's `bm25 === 0` fast-path — "graph-only surfacing is structurally impossible under the current multiplicative scorer." If benchmarks demand it, file as v2.1 scorer refactor, do NOT hack around it.
- AdaMem ablation's claim that graph expansion is worth 2.02 F1. If Phase 9 numbers show <0.5 F1 lift vs Tier-2-only, **something structural is wrong — do NOT tune λ values to paper over a structural bug.**
- One-path invariant test, CSS prefix invariant, index-mounts-wired invariant. Phase 9 adds none of its own wiring; these remain green.

---

## Task 0 — Spec §10 amendment (commit as `docs(spec):`)

**Objective:** Update `docs/specs/2026-04-20-starmem-v2-design.md` §10 to reflect the two Phase 8 module-layout deviations and rename the `src/eval/` placeholder as `bench/` (top-level, outside `src/` because the harness is non-runtime).

**Files:**

- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` §10

**Step 1 — Read the current §10 block**

```bash
sed -n '305,340p' docs/specs/2026-04-20-starmem-v2-design.md
```

Confirm the tree shows `src/eval/` and a flat `src/integration/`.

**Step 2 — Patch the three tree lines**

Replace these three lines:

```
│   ├── integration/            # settings UI, memory viewer, indicator
│   └── eval/                   # trace logger, pluggable scorer, harness stub
├── docs/
```

with:

```
│   └── integration/            # settings UI, memory viewer, indicator, event wiring
│       ├── viewer/             # viewer modal + per-tab renderers (Phase 8)
│       └── index.js            # integration barrel (Phase 8)
├── bench/                      # benchmarking harness — development-only, non-runtime
│   ├── loaders/                # corpus loaders (LoCoMo, synthetic)
│   ├── metrics/                # retrieval metrics (precision@k, recall@k, MRR)
│   ├── sweeps/                 # per-knob coordinate-descent drivers
│   ├── baselines/              # naive BM25, recency, random
│   └── runner.js               # orchestrator
├── docs/
│   └── bench/                  # measured values + per-sweep writeups
```

**Step 3 — Add a Phase 8 + 9 deviation note at the end of §10**

Append after the tree block (before §10.1):

```
**Layout deviations from the original draft:**

- Phase 8 added `src/integration/viewer/` (viewer modal + per-tab renderers) and `src/integration/index.js` (integration barrel). Originally §10 listed a flat `src/integration/`. The sub-directory is load-bearing: the viewer has five tabs, each ~100-200 LOC, and grouping them keeps the directory listing legible.
- Phase 9 moved the `src/eval/` placeholder out to a top-level `bench/` directory. Rationale: the harness is development-only (no SillyTavern runtime code references `bench/`), and grouping it with `docs/bench/` keeps both evaluation artifacts visually adjacent in a file tree.
```

**Step 4 — Verify nothing else broke**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all green (no source changes).

**Step 5 — Commit**

```bash
git add docs/specs/2026-04-20-starmem-v2-design.md
git commit -m "docs(spec): amend §10 module layout for Phase 8 + 9 deviations

Two amendments:
- Phase 8: src/integration/ sub-directory (viewer/) and barrel (index.js).
  Viewer has five tabs grouped for directory legibility.
- Phase 9: bench/ at the repo root, not src/eval/. Harness is
  development-only, non-runtime; groups with docs/bench/ artifacts.

Spec text (§10 tree block + deviation note appended) now matches the
as-shipped layout through Phase 9."
```

---

## Task 1 — LoCoMo corpus loader

**Objective:** Ship `bench/loaders/locomo.js` — fetches `data/locomo10.json` from `snap-research/locomo`, parses it into the harness's canonical corpus shape, and caches locally. Tests verify determinism and the cache path.

**Files:**

- Create: `bench/loaders/locomo.js`
- Create: `bench/loaders/index.js` (barrel)
- Create: `tests/unit/bench/loaders/locomo.test.js`
- Create: `bench/.gitignore` (ignore `bench/.cache/`)

**Canonical corpus shape (inter-task contract):**

```typescript
type CorpusConversation = {
  id: string;                    // locomo convo id
  turns: Turn[];                 // chronological utterances
  qa: QAItem[];                  // question-answer pairs with evidence
}

type Turn = {
  speaker: string;               // "Caroline" | "Melanie" | ...
  text: string;
  sessionId: number;             // LoCoMo session index
  turnIndex: number;             // 0-based within conversation
}

type QAItem = {
  question: string;
  answer: string;                // canonical answer text
  evidenceTurns: number[];       // turnIndex values supporting the answer
  category: string;              // LoCoMo's question category (if present)
}
```

**Step 1 — Write failing tests**

Create `tests/unit/bench/loaders/locomo.test.js`:

```javascript
import { describe, test, expect, beforeAll } from '@jest/globals';
import { loadLocomo, CANONICAL_URL } from '../../../../bench/loaders/locomo.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

describe('loadLocomo', () => {
    let corpus;

    beforeAll(async () => {
        corpus = await loadLocomo({ maxConversations: 2, offline: false });
    }, 30000);

    test('returns an array of conversations', () => {
        expect(Array.isArray(corpus)).toBe(true);
        expect(corpus.length).toBe(2);
    });

    test('each conversation has id, turns, qa', () => {
        for (const c of corpus) {
            expect(typeof c.id).toBe('string');
            expect(Array.isArray(c.turns)).toBe(true);
            expect(Array.isArray(c.qa)).toBe(true);
            expect(c.turns.length).toBeGreaterThan(0);
        }
    });

    test('turns are well-formed', () => {
        for (const turn of corpus[0].turns) {
            expect(typeof turn.speaker).toBe('string');
            expect(typeof turn.text).toBe('string');
            expect(typeof turn.sessionId).toBe('number');
            expect(typeof turn.turnIndex).toBe('number');
        }
    });

    test('qa items reference evidence turns that exist', () => {
        for (const qa of corpus[0].qa) {
            for (const tid of qa.evidenceTurns) {
                expect(tid).toBeGreaterThanOrEqual(0);
                expect(tid).toBeLessThan(corpus[0].turns.length);
            }
        }
    });

    test('canonical url points at snap-research', () => {
        expect(CANONICAL_URL).toContain('snap-research/locomo');
    });

    test('second call hits the cache (fast, no network)', async () => {
        const t0 = Date.now();
        const again = await loadLocomo({ maxConversations: 2, offline: true });
        expect(again.length).toBe(2);
        expect(Date.now() - t0).toBeLessThan(500);
    });

    test('offline=true fails cleanly if no cache', async () => {
        const fakeCache = path.resolve('/tmp/nonexistent-locomo-cache');
        await expect(
            loadLocomo({ cachePath: fakeCache, offline: true })
        ).rejects.toThrow(/no cached corpus/i);
    });
});
```

**Step 2 — Run test to verify failure**

```bash
npm test -- --testPathPattern=bench/loaders/locomo
```

Expected: FAIL — "Cannot find module".

**Step 3 — Implement `bench/loaders/locomo.js`**

Create the file via `write_file` (heredoc has the secrets-guard trap — avoid for source):

```javascript
/**
 * LoCoMo corpus loader.
 *
 * Fetches `data/locomo10.json` from snap-research/locomo on first call,
 * caches it under `bench/.cache/`, and normalizes into the harness's
 * canonical corpus shape:
 *   [{ id, turns: [{ speaker, text, sessionId, turnIndex }], qa: [...] }]
 *
 * Design decisions:
 * - Cache key is the raw GitHub URL; busting is manual (delete the cache).
 * - Offline mode skips the network even if cache is stale. Use for
 *   determinism in CI and sweep reruns.
 * - `maxConversations` truncates the corpus for quick-smoke runs. Full
 *   LoCoMo is 10 conversations; benchmarks usually want all.
 *
 * @module bench/loaders/locomo
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_URL =
    'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

const DEFAULT_CACHE = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'locomo10.json',
);

/**
 * @param {object} [opts]
 * @param {number} [opts.maxConversations] - truncate to this many
 * @param {boolean} [opts.offline=false] - skip network; require cache
 * @param {string} [opts.cachePath] - override cache location
 * @returns {Promise<CorpusConversation[]>}
 */
export async function loadLocomo(opts = {}) {
    const { maxConversations, offline = false, cachePath = DEFAULT_CACHE } = opts;

    let raw;
    if (existsSync(cachePath)) {
        raw = await readFile(cachePath, 'utf8');
    } else if (offline) {
        throw new Error(
            `loadLocomo: no cached corpus at ${cachePath} and offline=true`,
        );
    } else {
        const res = await fetch(CANONICAL_URL);
        if (!res.ok) {
            throw new Error(
                `loadLocomo: fetch failed — ${res.status} ${res.statusText}`,
            );
        }
        raw = await res.text();
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, raw, 'utf8');
    }

    const json = JSON.parse(raw);
    const corpus = normalizeLocomo(json);

    return maxConversations != null
        ? corpus.slice(0, maxConversations)
        : corpus;
}

/**
 * Normalize raw LoCoMo JSON to the canonical shape.
 *
 * LoCoMo's raw shape (observed from the dataset):
 *   [{ sample_id, conversation: { session_1: [...], session_2: [...], ... },
 *      qa: [{ question, answer, evidence, category }] }]
 *
 * Sessions are keyed `session_N`; each is an array of turns with
 * `speaker` and `text` (and sometimes `img_url` — ignored here).
 * `evidence` is an array of turn identifiers like "D1:S1:T3" — we map
 * these into flat turnIndex values.
 *
 * @param {any} json
 * @returns {CorpusConversation[]}
 */
function normalizeLocomo(json) {
    if (!Array.isArray(json)) {
        throw new Error('loadLocomo: expected top-level array');
    }
    return json.map(sample => {
        const turns = [];
        const sessionKeys = Object.keys(sample.conversation || {})
            .filter(k => k.startsWith('session_'))
            .sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));

        const turnByEvidenceKey = new Map();

        for (const sKey of sessionKeys) {
            const sessionId = parseInt(sKey.slice(8), 10);
            const sessionTurns = sample.conversation[sKey] || [];
            for (let i = 0; i < sessionTurns.length; i++) {
                const t = sessionTurns[i];
                const turnIndex = turns.length;
                turns.push({
                    speaker: t.speaker ?? 'unknown',
                    text: t.text ?? t.content ?? '',
                    sessionId,
                    turnIndex,
                });
                // Map LoCoMo evidence key "D<sampleOrd>:S<session>:T<index>"
                // to flat turnIndex. D is constant per-sample so we ignore it.
                turnByEvidenceKey.set(`S${sessionId}:T${i}`, turnIndex);
            }
        }

        const qa = (sample.qa || []).map(item => ({
            question: item.question,
            answer: String(item.answer ?? ''),
            evidenceTurns: parseEvidence(item.evidence, turnByEvidenceKey),
            category: item.category ?? 'unknown',
        }));

        return {
            id: String(sample.sample_id ?? sample.id ?? 'unknown'),
            turns,
            qa,
        };
    });
}

function parseEvidence(evidence, turnByEvidenceKey) {
    if (!Array.isArray(evidence)) return [];
    const out = [];
    for (const ref of evidence) {
        const m = String(ref).match(/S(\d+):T(\d+)/);
        if (!m) continue;
        const key = `S${m[1]}:T${m[2]}`;
        const idx = turnByEvidenceKey.get(key);
        if (idx != null) out.push(idx);
    }
    return out;
}
```

Create `bench/loaders/index.js`:

```javascript
export { loadLocomo, CANONICAL_URL } from './locomo.js';
```

Create `bench/.gitignore`:

```
.cache/
```

**Step 4 — Run test to verify pass**

```bash
npm test -- --testPathPattern=bench/loaders/locomo
```

Expected: PASS (7 tests).

**Note:** If the first run hits the network for real, the `cachePath` will now exist. The second test explicitly exercises the cache-hit path; the last test points at a nonexistent cache + offline=true and verifies the error message.

**Step 5 — Commit**

```bash
git add bench/loaders/ bench/.gitignore tests/unit/bench/loaders/
git commit -m "feat(bench): LoCoMo corpus loader

Fetches snap-research/locomo data/locomo10.json on first call, caches
under bench/.cache/, normalizes to canonical corpus shape:
  [{ id, turns: [{ speaker, text, sessionId, turnIndex }], qa: [...] }]

Evidence keys like 'D1:S1:T3' map to flat turnIndex for harness use.
Offline mode fails closed with a descriptive error if no cache exists.

7 tests: loader shape, turn well-formedness, qa evidence resolution,
canonical URL, cache fast-path, offline-no-cache error path."
```

---

## Task 2 — Retrieval metrics library

**Objective:** Ship `bench/metrics/retrieval.js` — precision@k, recall@k, MRR, and the Jaccard-based gold matcher. Pure functions over the canonical corpus shape from Task 1.

**Files:**

- Create: `bench/metrics/retrieval.js`
- Create: `bench/metrics/index.js` (barrel)
- Create: `tests/unit/bench/metrics/retrieval.test.js`

**Gold-match semantics (inter-task contract):**

A returned entry matches a gold evidence turn iff `jaccard(tokenize(entry.content), tokenize(goldTurnText)) >= 0.5`. Rationale: LoCoMo's `evidence` points at conversation turns, but STARmem stores extracted facts whose wording differs. 0.5 is loose enough to credit "Caroline's birthday is in March" against the source turn "Oh, my birthday's coming up in March!" yet strict enough to reject unrelated entries. Tokenizer is imported from `src/retrieval/bm25.js` — using a different tokenizer would measure the wrong thing.

**Step 1 — Write failing tests via `write_file`**

Content for `tests/unit/bench/metrics/retrieval.test.js` (see Step 3 for expected semantics):

- Import `{ precisionAtK, recallAtK, mrr, matchGold, computeMetrics }` from the module.
- Fixtures: 4 retrieved entries, 2 gold turns.
- `matchGold` returns `{ matchedIds: Set, perGold: Record<number, string[]> }`.
- `precisionAtK(matched, ranked, k)`: at k=1 with hit at position 0 returns 1.0; at k=2 with one hit returns 0.5; at k=5 with 2 matches in 3 results returns 2/3 (no padding); empty retrieval returns 0.
- `recallAtK(matched, ranked, k)`: all relevant in top-k returns 1.0; partial returns partial; empty gold returns 1 (vacuous).
- `mrr(matched, ranked)`: rank 1 → 1.0, rank 3 → 1/3, no match → 0.
- `computeMetrics([runs])`: returns `{ n, precisionAtK: {1,3,5,10}, recallAtK: {1,3,5,10}, mrr }`.

Total: ~12 tests.

**Step 2 — Run test to verify failure**

```bash
npm test -- --testPathPattern=bench/metrics/retrieval
```

Expected: FAIL — "Cannot find module".

**Step 3 — Implement `bench/metrics/retrieval.js` via `write_file`**

Module structure (prose, not verbatim code — subagent writes the code from this spec):

1. **Imports:** `tokenize` from `../../src/retrieval/bm25.js`. `bench/` is development-only — importing from `src/` is fine, same rationale as tests.

2. **Constants:**
   - `DEFAULT_GOLD_THRESHOLD` = 0.5 (exported).
   - `STANDARD_K` = `[1, 3, 5, 10]` (exported).

3. **`jaccard(a, b)`:** both empty → 1; compute intersection over union on sets; return `inter / union` (0 if union 0).

4. **`matchGold(retrieved, goldTurns, opts = {})`:**
   - Threshold from `opts.threshold` or `DEFAULT_GOLD_THRESHOLD`.
   - For each retrieved entry, tokenize content; for each gold turn, tokenize text; if Jaccard ≥ threshold, add entry id to `matchedIds` and push into `perGold[goldTurn.turnIndex]`.
   - Return `{ matchedIds: Set<string>, perGold: Record<number, string[]> }`.

5. **`precisionAtK(matchedIds, rankedIds, k)`:**
   - Empty `rankedIds` → 0.
   - Take top-k; denominator is `min(k, rankedIds.length)` (no padding).
   - Count hits where `matchedIds.has(id)`.

6. **`recallAtK(matchedIds, rankedIds, k)`:**
   - Empty `matchedIds` → 1.0 (vacuous).
   - Take top-k as set; count how many of `matchedIds` are in it.
   - Return `hits / matchedIds.size`.
   - Docblock must explain: `matchedIds` is typically computed from the full retrieval, so recall@k measures "what fraction of retrievable gold appears in top-k," not "what fraction of gold turns have any match anywhere."

7. **`mrr(matchedIds, rankedIds)`:**
   - Walk `rankedIds`; return `1/(i+1)` at first matched id. 0 if no match.

8. **`computeMetrics(runs, opts = {})`:**
   - `kValues` from `opts.kValues` or `STANDARD_K`.
   - Init `precisionAtK_` and `recallAtK_` dicts with 0 per k.
   - For each run `{ retrieved, goldTurns }`: compute matched ids via `matchGold`, extract `rankedIds = retrieved.map(r => r.id)`, accumulate per-k precision/recall and MRR.
   - Divide by `n = runs.length || 1`.
   - Return `{ n: runs.length, precisionAtK, recallAtK, mrr }`.

Barrel file `bench/metrics/index.js` re-exports everything above.

**Step 4 — Run tests**

```bash
npm test -- --testPathPattern=bench/metrics/retrieval
```

Expected: PASS.

If a matchGold test fails because the sample fixture's Jaccard scores are under 0.5, loosen the assertion (`toBeGreaterThanOrEqual(1)`) rather than the threshold — the threshold is the measured default and must not be tuned to pass trivial tests.

**Step 5 — Commit**

```bash
git add bench/metrics/ tests/unit/bench/metrics/
git commit -m "feat(bench): retrieval metrics — precision@k, recall@k, MRR

Pure functions over the canonical harness contract:
  retrieved: [{ id, content, score }]
  goldTurns: [{ turnIndex, text }]

Gold-match uses Jaccard over the same tokenizer as bm25 (imported from
src/retrieval/bm25.js — bench/ is development-only). Threshold 0.5 is
the default; caller can override per-run.

computeMetrics aggregates over a batch of runs at k in {1,3,5,10}.
Recall measures |matched in top-k| / |matched| — fraction of
retrievable gold appearing in top-k.\"
```

---

## Task 3 — Harness runner + CLI

**Objective:** Ship `bench/runner.js` + `bench/cli.js` — the orchestrator that seeds STARmem from a corpus, replays QA queries through the public retrieval ladder, captures traces, and emits JSONL + per-run metrics. This is the centerpiece. Every sweep in Tasks 4-7 is a thin driver around this runner.

**Files:**

- Create: `bench/runner.js` (core orchestration, importable as a function)
- Create: `bench/cli.js` (Node CLI entry point with arg parsing)
- Create: `bench/harness/seeder.js` (turn-by-turn conversation → STARmem state)
- Create: `bench/harness/index.js` (barrel)
- Create: `tests/unit/bench/runner.test.js`
- Create: `tests/integration/bench/runner.integration.test.js`
- Modify: `package.json` (add `"bench"` script)

**Harness call contract (inter-task — Tasks 4-7 use this):**

```typescript
runHarness({
  corpus: CorpusConversation[],
  scorerId?: string,                    // null → current default
  overrides?: { [knob: string]: number }, // applied to constants at setup
  chatIdPrefix?: string,
  onProgress?: (pct: number) => void,
}): Promise<{
  runs: Array<{
    conversationId: string,
    qa: QAItem,
    retrieved: Array<{ id, content, score, tier }>,
    goldTurns: Array<{ turnIndex, text }>,
    traces: TraceEntry[],
    latencyMs: number,
  }>,
  metrics: MetricsReport,
  envSnapshot: { constants, scorerId, nodeVersion, gitSha }
}>
```

**Step 1 — Write failing unit tests**

`tests/unit/bench/runner.test.js`:

- Arg parsing: `runHarness({ corpus: [] })` returns `{ runs: [], metrics, envSnapshot }` with empty runs array. (Smoke — no actual retrieval yet.)
- `envSnapshot` includes `gitSha` (read from `git rev-parse HEAD`) and `nodeVersion` (`process.version`).
- `overrides` are surfaced in `envSnapshot.constants` as the effective values, not the defaults.

Total: ~5 tests.

**Step 2 — Write failing integration test**

`tests/integration/bench/runner.integration.test.js` (jsdom environment):

- Fixture: 2-conversation synthetic corpus with known QA pairs (6 turns, 2 QA items per convo).
- Exercise: `runHarness({ corpus })` returns runs with non-empty `retrieved` for each QA item, valid traces, and `metrics.precisionAtK[1]` > 0.
- One run with `overrides: { TAU_CONFIDENCE: 999 }` to verify the override path — Tier 2 exit condition should now never fire, forcing Tier 3 fallthrough visible in `traces`.

Total: ~4 tests.

**Step 3 — Implement `bench/harness/seeder.js`**

Turn-by-turn seeder that takes a `CorpusConversation` and walks it through STARmem as if it were a real chat:

1. **Init** — `loadState(chatId)` creates empty state; apply any knob overrides (see Step 5 below for the override mechanism).
2. **For each turn in chronological order:**
   - Append to working buffer via `consolidate` dependencies (reuse the pipeline.test.js pattern — push to `workingBuffer`, tick idle timer as needed).
   - Every 5 turns, call `consolidate(chatId)` to drain working → episodic (matches Phase 6's BATCH_SIZE).
   - If conversation is ≥100 turns in, trigger `rebuildPersona(chatId)` once with an injected synthetic embedding client (the one from `raptor/embeddings.js`) — this is a stub for Phase 9, real-embedding seeding is deferred to 9.5.
3. **Returns** the chatId + fully seeded state hash for reproducibility.

Implementation notes for the subagent:
- Fact extraction in the seeder uses a deterministic rule-based fallback (regex over pronouns + proper nouns), not a real LLM call — benchmarks must be reproducible without network. The real `extractFacts.js` is exercised in a separate live-LLM sub-bench (also deferred to 9.5).
- The seeder is the heaviest component of the runner (~200-300 LOC). Budget two `write_file` calls, chunked, if needed.

**SHIPPED IN 3b (2026-04-21, commit `8b037bb`):** `bench/harness/seeder.js` exports `seedConversation(conv, opts)` which installs the mock extractor inline via `_setLLMClientForTests` — no separate `st-mock.js` needed. With `opts.keepBackend = true` the runner reuses the seeded state + in-memory backend. Return shape is `{ chatId, stateHash, factCount, turnsProcessed }`.

**Step 4 — Implement `bench/runner.js`**

Top-level orchestrator:

1. Accept the call contract above.
2. Apply `overrides` via `setConstantOverrides(overrides)` from `src/core/constants.js` at setup; capture restore function for try/finally teardown.
3. For each conversation in corpus:
   - Generate a unique chatId (`${chatIdPrefix ?? 'bench'}-${conv.id}`).
   - Seed via `seedConversation(conv, { chatId, keepBackend: true })` from `bench/harness/seeder.js`.
   - Call `loadState(chatId)` to get the seeded `State` object (seeder left the backend warm).
   - For each QA item: capture `performance.now()`, call `retrieve(state, qa.question, { k: 10 })` from `src/retrieval/ladder.js`, record latency, capture the returned `trace` directly (the public signature returns `{ entries, tierResolved, trace, state }` — no need to snapshot `state.runtime.traces`).
   - Resolve `goldTurns` by mapping `qa.evidenceTurns` (flat turnIndex numbers — see `bench/loaders/locomo.js` §parseEvidence) against `conv.turns` to produce `{ turnIndex, text }` entries.
   - Push run record including the retrieved `entries` (mapped to `{ id, content, score, tier }`) and `traces` (the single returned trace, wrapped in an array for harness-contract symmetry with older signatures).
4. Feed all runs into `computeMetrics` from Task 2.
5. Build `envSnapshot`:
   - `constants`: read from `src/core/constants.js` after overrides applied (spread `RETRIEVAL` + `CONSOLIDATION`).
   - `gitSha`: `execSync('git rev-parse HEAD').trim()`.
   - `nodeVersion`: `process.version`.
   - `scorerId`: `getScorerId()` from `src/retrieval/scorer.js`.
6. In `finally`, call the restore function from step 2 and `_resetBackendForTests()` / `_resetLocksForTests()` (seeder skipped these because `keepBackend=true`).
7. Return the composite result.

**Step 5 — Knob override mechanism (REVISED 2026-04-21 after Task 2 preflight audit)**

**Plan-bug caught preflight:** Original plan assumed `export const TAU_CONFIDENCE = 2.0` (flat), but `src/core/constants.js` actually groups swept values inside `export const RETRIEVAL = Object.freeze({...})` / `CONSOLIDATION = Object.freeze({...})`, and **five modules destructure at module-load time** (`bm25.js`, `tier1-fuzzy.js`, `tier2-bm25.js`, `dedup.js`, `triggers.js`). Even if the group were mutable, the destructures snapshot values once at import — immune to later overrides.

**Corrected strategy:**

1. **Unfreeze the two groups that hold swept knobs** — `RETRIEVAL` and `CONSOLIDATION`. Leave other groups (`LIFECYCLE`, `PERSONA_REBUILD`, `EDGE_TYPE_WEIGHTS`, etc.) frozen; nothing in Phase 9 sweeps their values.
2. **Remove module-top destructures** for the swept keys. Rewrite consumers to read via the group at each call site: `RETRIEVAL.TIER2_TAU_CONFIDENCE` instead of the destructured local. Values unchanged by sweeps (e.g. `BM25_K1`, `WORKING_BUFFER_THRESHOLD`) can stay destructured at module top — they're still `const`-shaped in practice. The grep invariant in the guard test enumerates only the swept keys as "must-not-destructure-at-top."
3. **Add `setConstantOverrides(obj)` / `resetConstantOverrides()`** helpers in `constants.js`. Mutate the group objects in place. Return a restore function for try/finally use.
4. **Guard test** asserts (a) `RETRIEVAL` and `CONSOLIDATION` are NOT `Object.isFrozen(...) === true`, (b) no source file contains a module-top destructure of any of the 11 swept keys from `RETRIEVAL` or `CONSOLIDATION` (grep invariant, comment-stripped), (c) `setConstantOverrides({ TIER2_TAU_CONFIDENCE: 5 })` round-trips and `resetConstantOverrides()` restores 2.0. Tripwire-verify by reinstating one destructure and watching the guard fail.

**The list of swept keys (enumerated by grep invariant):**
- In `RETRIEVAL`: `TIER2_TAU_CONFIDENCE`, `TIER2_TAU_GAP`, `TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `TIER3_BEAM_WIDTH`, `TIER3_MAX_HOPS`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT`, `EXPLICIT_RELATION_WEIGHT`, `SUBJECT_BOOST`, `TAG_BOOST`.
- In `CONSOLIDATION`: `DEDUP_JACCARD_THRESHOLD`.

12 keys total (same as original plan). Dedup threshold is the only `CONSOLIDATION` swept value.

**Call sites needing rewrite to read-through-group:**
- `src/retrieval/bm25.js:13` — `SUBJECT_BOOST`, `TAG_BOOST`
- `src/retrieval/tier2-bm25.js:14` — `TIER2_TAU_CONFIDENCE`, `TIER2_TAU_GAP`
- `src/retrieval/tier3-graph.js` — `TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `TIER3_BEAM_WIDTH`, `TIER3_MAX_HOPS`
- `src/memory/edgeBuilder.js` — `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT`, `EXPLICIT_RELATION_WEIGHT`
- `src/consolidation/dedup.js:19` — `DEDUP_JACCARD_THRESHOLD`

`src/retrieval/tier1-fuzzy.js` (FUZZY_JACCARD_THRESHOLD) and `src/consolidation/triggers.js` (WORKING_BUFFER_THRESHOLD, IDLE_TRIGGER_SECONDS) destructure non-swept keys — leave them alone.

**Task 3 is now split into 3a / 3b / 3c** to shrink per-delegation payload (Azure flake mitigation):

- **Task 3a — Constants override infrastructure.** Unfreeze `RETRIEVAL` + `CONSOLIDATION`; rewrite 5 callsites to read through the group; add `setConstantOverrides` + `resetConstantOverrides`; write the guard test. ~1-1.5 KB of edits total. Fully controller-friendly or subagent depending on load.
- **Task 3b — Harness seeder** (`bench/harness/seeder.js` + `bench/harness/st-mock.js`). 200-300 LOC, self-contained, pure function from corpus to seeded state.
- **Task 3c — Runner + CLI** (`bench/runner.js`, `bench/cli.js`, integration test, `package.json` bench scripts). Depends on 3a's override mechanism and 3b's seeder.

**Step 6 — Implement `bench/cli.js`**

Node CLI with `process.argv` parsing (no dep on yargs / commander — stick to stdlib):

```
node bench/cli.js [--corpus locomo] [--conversations N] [--scorer default]
                  [--overrides "TAU_CONFIDENCE=2.5,TAU_GAP=0.8"]
                  [--out docs/bench/runs/YYYY-MM-DD-HH-MM-SS.jsonl]
                  [--metrics-out docs/bench/runs/YYYY-MM-DD-HH-MM-SS.metrics.json]
                  [--offline]
```

Defaults: corpus=`locomo`, conversations=all, scorer=default, overrides=none, out=`docs/bench/runs/<timestamp>.jsonl`, metrics-out same path with `.metrics.json` suffix.

JSONL: one line per `run` entry. `metrics.json`: the `MetricsReport` + `envSnapshot`.

**Step 7 — Wire `package.json`**

Add to `scripts`:

```json
"bench": "node bench/cli.js",
"bench:smoke": "node bench/cli.js --conversations 1"
```

**Step 8 — Run tests**

```bash
npm run lint && npm run typecheck && npm test -- --testPathPattern=bench
```

Expected: all existing suites still green + ~9 new bench tests passing.

**Step 9 — Smoke the CLI end-to-end**

```bash
mkdir -p docs/bench/runs
npm run bench:smoke -- --offline
```

(The `--offline` flag will fail on first run because no cache exists; then run without `--offline` once to warm the cache, then re-run with `--offline` for the actual smoke.)

Expected output:
- A `docs/bench/runs/*.jsonl` with at least 1 run entry.
- A `*.metrics.json` next to it with non-null precision@1/3/5/10.
- Console shows `metrics { precisionAtK, recallAtK, mrr }` summary + envSnapshot.

**Step 10 — Commit**

```bash
git add bench/runner.js bench/cli.js \
        tests/unit/bench/runner.test.js \
        tests/integration/bench/runner.integration.test.js \
        package.json
git commit -m "feat(bench): harness runner + CLI (Task 3c)

Core orchestration for Phase 9 benchmarking. runHarness seeds STARmem
from a corpus via bench/harness/seeder.js (Task 3b), applies any knob
overrides via setConstantOverrides (Task 3a), replays QA queries
through the public retrieve() ladder, captures traces and latencies,
and emits aggregated metrics.

bench/cli.js is a thin wrapper — stdlib argv parsing + JSONL/metrics
file I/O. 'npm run bench:smoke' runs one conversation end-to-end.

envSnapshot records git SHA, node version, active scorer id, and the
effective constants (post-override) for reproducibility.

9 new tests (5 runner unit + 4 integration); all existing suites green."
```

Note: constants-override infra and the guard test shipped in Task 3a (`3c28d2e`); seeder shipped in 3b (`8b037bb`) — this commit adds only the runner + CLI on top.

---

## Task 4 — Sweep driver scaffolding + τ_confidence / τ_gap sweep

**Objective:** Ship the sweep driver shape (reusable across Tasks 5-7) and the first sweep: τ_confidence and τ_gap (Tier 2 exit condition). Output goes to `docs/bench/sweeps/YYYY-MM-DD-tau.md` with an elbow recommendation.

**Files:**

- Create: `bench/sweeps/_driver.js` (shared coordinate-descent loop)
- Create: `bench/sweeps/tau.js`
- Create: `tests/unit/bench/sweeps/driver.test.js`
- Create: `docs/bench/sweeps/` (directory)
- Create: `docs/bench/sweeps/TEMPLATE.md` (sweep writeup template)

**Shared driver contract (Tasks 5-7 reuse):**

```typescript
sweep({
  name: string,                                  // 'tau', 'graph', ...
  knobs: Array<{ name: string, values: number[] }>,  // cartesian product
  corpus: CorpusConversation[],
  primaryMetric: 'recallAt5' | 'precisionAt3' | 'mrr',  // for elbow detection
  onComplete?: (results: SweepResult) => void,
}): Promise<SweepResult>

type SweepResult = {
  name: string,
  points: Array<{
    overrides: { [name: string]: number },
    metrics: MetricsReport,
    latencyMs: { p50, p95 },
  }>,
  elbow: { overrides, rationale },
  raw: string,                                   // all runs as JSONL
}
```

The driver:
1. Generates the cartesian product of `knobs[].values`.
2. For each point, calls `runHarness({ corpus, overrides: point })`.
3. Records per-point metrics + latency.
4. After all points, detects the "elbow" — the highest primary-metric value such that a 10% further knob change yields <1% metric gain. (Knobs are scalar; if they're not, sort by first-knob value.)
5. Writes the JSONL + a summary report.

**Task-specific knobs (τ sweep):**

- `TIER2_TAU_CONFIDENCE`: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
- `TIER2_TAU_GAP`: [0.1, 0.25, 0.5, 0.75, 1.0, 1.5]

**Note on key names:** The override keys MUST use the full swept-key names from `_SWEPT_RETRIEVAL_KEYS` (i.e. `TIER2_TAU_CONFIDENCE`, not the short `TAU_CONFIDENCE`). `setConstantOverrides` throws on unknown keys — verified against `src/core/constants.js` (3a).

**Note on primary metric lookup:** `MetricsResult` exposes `precisionAtK: Record<number, number>`, `recallAtK: Record<number, number>`, `mrr: number`. The driver's `primaryMetric` values map as follows:
- `'recallAt5'` → `metrics.recallAtK[5]`
- `'precisionAt3'` → `metrics.precisionAtK[3]`
- `'mrr'` → `metrics.mrr`

Put a `METRIC_ACCESSORS` lookup table at the top of `_driver.js` to keep this in one place.

48-point grid. LoCoMo 10-conversation full run ≈ 300 QA items. ~15,000 retrievals total. Per-retrieval budget ≤100ms → 25 minutes worst case. Acceptable.

**Note on "coordinate descent":** The plan uses the term loosely. Implementation is a full cartesian grid evaluation (all 48 points). Elbow detection runs along the primary-knob axis (τ_confidence by default for this sweep) with the other knob's values either marginalized (mean) or held at the best-performing value — driver picks one and documents the choice.

**Step 1 — Write failing driver test**

`tests/unit/bench/sweeps/driver.test.js`:

- Pass a fake `runHarness` via dependency injection (add `_runHarness` param to `sweep`); verify it's called once per cartesian-product point.
- Verify elbow detection on a hand-crafted metric curve (e.g. recall shape `[0.1, 0.3, 0.5, 0.52, 0.53, 0.53]` → elbow at index 2).
- Verify `SweepResult.raw` is valid JSONL (every line parses).

**Step 2-4 — Implement driver + τ sweep (via `write_file`)**

Driver in `bench/sweeps/_driver.js`:
- Cartesian product helper.
- Coordinate-descent loop.
- Elbow detection: monotone-metric heuristic. For each consecutive pair of points sorted by primary knob, if Δmetric/Δknob drops below `ELBOW_RATIO` (default 0.1) of the maximum observed Δ, that's the elbow.
- JSONL writer.

τ sweep in `bench/sweeps/tau.js`:
- Import `sweep`, `loadLocomo`, `runHarness`.
- Configure knobs as listed above.
- `npm run bench:sweep:tau -- --conversations 10 --primary recallAt5` runs the sweep.
- Post-run, emit a Markdown report to `docs/bench/sweeps/YYYY-MM-DD-tau.md` with:
  - Point-by-point table (overrides → metrics → latency).
  - Heatmap-ish summary (ASCII grid of primary metric per (τ_conf, τ_gap)).
  - Elbow recommendation + rationale.
  - Spec-amendment proposal if the elbow is >50% from the current spec value.

**Step 5 — Wire package.json**

```json
"bench:sweep:tau": "node bench/sweeps/tau.js"
```

**Step 6 — Run the sweep (SMOKE ONLY at task-commit time)**

```bash
npm run bench:sweep:tau -- --conversations 2   # smoke
# Full 10-conversation run deferred to the controller — subagent stops here.
```

The smoke run fetches LoCoMo once (first call populates `docs/bench/cache/locomo.json`; the runner's cache-or-network logic lives in `bench/loaders/locomo.js` and needs no change). Expected output: `docs/bench/sweeps/<date>-tau.md` lands locally but is **NOT committed**. The subagent verifies the file exists, the table has 48 rows, and the elbow block is populated, then stops.

**If the network fetch fails** (runtime is offline or CI-like), the subagent may synthesize a 2-conversation × 6-turn × 2-QA corpus inline (matching the integration test fixture) and pass it via a `--synthetic` flag instead of `--conversations 2`. Add the flag support in `bench/sweeps/tau.js`. The goal is end-to-end exercise of the driver, not real LoCoMo numbers.

The controller runs the full 10-conversation sweep separately, reviews the report, and decides whether to commit any spec amendment.

**Step 7 — Commit**

```bash
git add bench/sweeps/ tests/unit/bench/sweeps/ docs/bench/sweeps/TEMPLATE.md \
        package.json
git commit -m "feat(bench): sweep driver + tau_confidence/tau_gap sweep

Shared coordinate-descent driver (bench/sweeps/_driver.js) emits JSONL
per-point and detects the elbow of the primary metric curve. Drivers
for the remaining three sweeps (Tasks 5-7) plug in via the same contract.

tau.js sweeps the Tier 2 exit condition — 8 tau_conf values x 6 tau_gap
values = 48 points on full LoCoMo. Writeup lands in
docs/bench/sweeps/<date>-tau.md; elbow recommendation flagged for
controller review. Spec amendment deferred to the end-of-phase commit."
```

---

## Task 5 — Graph sweep (λ₁, λ₂, beam, edge cap, co-occurrence weight)

**Objective:** Sweep the five Tier-3 / graph-construction knobs. Same driver shape as Task 4.

**Files:**

- Create: `bench/sweeps/graph.js`
- Modify: `bench/sweeps/_driver.js` (add `baseOverrides` support — backward-compatible)
- Modify: `tests/unit/bench/sweeps/driver.test.js` (add 1-2 tests for `baseOverrides` merge behavior)
- Modify: `package.json` (add `bench:sweep:graph`)

**Knobs (using full swept-key names from `_SWEPT_RETRIEVAL_KEYS`):**

- `TIER3_LAMBDA_1`: [0.5, 0.75, 1.0, 1.25, 1.5]
- `TIER3_LAMBDA_2`: [0.1, 0.2, 0.3, 0.4, 0.5]
- `TIER3_BEAM_WIDTH`: [3, 5, 8, 10]
- `EDGE_CAP_PER_ENTRY`: [10, 15, 20, 30, 50]
- `COOCCURRENCE_WEIGHT`: [0.25, 0.5, 0.75, 1.0]  (`EXPLICIT_RELATION_WEIGHT` stays at spec default 1.0 as anchor)

**Note on key names:** Same as Task 4 — use the full swept-key names or `setConstantOverrides` throws. Short names like `LAMBDA_1` / `BEAM_WIDTH` / `EDGE_CAP` are not in `_SWEPT_RETRIEVAL_KEYS`.

Full cartesian = 2000 points — too expensive. **Coordinate descent, not grid:**

1. Freeze 4 knobs at their spec defaults, sweep the 5th.
2. Commit the elbow value of that 5th knob.
3. Move to the next knob (now sweeping around the just-committed value, with previously-committed knobs held at their elbow).
4. Order: `TIER3_LAMBDA_1` → `TIER3_LAMBDA_2` → `TIER3_BEAM_WIDTH` → `EDGE_CAP_PER_ENTRY` → `COOCCURRENCE_WEIGHT`. Rationale: scoring knobs first (they're most sensitive), then structural knobs (caps), then weight ratios.

5 × ~6 points = ~23-24 runs total (5 knobs × avg 4.6 values). Each run seeds all N conversations once per sweep point — from Task 4 we know seeding dominates retrieval cost, so budget ~300 seedings for a 10-conv run. Smoke uses synthetic fixture; controller runs full LoCoMo separately.

**Driver extension required (pre-requisite for graph.js):**

The Task 4 driver accepts `{ knobs, corpus, primaryMetric }` and builds cartesian. For coordinate descent, graph.js needs the driver to accept a `baseOverrides` object that gets merged with each grid point before `runHarness` is called. Add this as an OPTIONAL field (default `{}`) to `sweep()` — Task 4's tau.js continues to work unchanged. graph.js then calls `sweep()` five times in sequence, feeding forward the elbow of each round as the next round's `baseOverrides`.

Signature after the extension:

```js
sweep({
  name,
  knobs,               // for graph.js each round is a 1-element array
  corpus,
  primaryMetric,
  baseOverrides,       // NEW — merged with each point, default {}
  onComplete,
  _runHarness,
})
```

Inside `sweep()`, build the per-point override as `{ ...baseOverrides, ...point }`. Record the effective override (merged) in each point's result entry.

**Steps:** mirror Task 4 — prose spec, call the shared driver, one sweep script per knob-sequence, write `docs/bench/sweeps/YYYY-MM-DD-graph.md` at the end.

**Critical invariant (from Phase 5 retro, must appear in the sweep writeup):**

> AdaMem ablation claims graph expansion is worth 2.02 F1. If Phase 9 numbers on a matched benchmark show <0.5 F1 lift vs Tier-2-only, something structural is wrong — do NOT tune λ values to paper over a structural bug.

The sweep report must include a **"Tier-2-only baseline"** row and a **"graph contribution" column** showing `metric(with-graph) − metric(Tier-2-only)`. Anything under 0.05 MRR lift triggers a STOP in the sweep and a note to the controller before moving on.

**Baseline row mechanism:** Force Tier 2 to exit successfully by overriding `TIER2_TAU_CONFIDENCE: 0.01`. This makes Tier 2 always meet its exit condition and prevents fallthrough to Tier 3, giving a clean "no graph expansion" comparison point. Document this choice in the report. (Avoid `TIER3_LAMBDA_2=0 + TIER3_BEAM_WIDTH=0` — those produce empty Tier 3 expansions with tied scores, not a clean Tier-2-only result.)

**Commit:**

```bash
git add bench/sweeps/graph.js docs/bench/sweeps/*-graph.md package.json
git commit -m "feat(bench): graph knob sweep — lambda/beam/cap/cooccurrence

Coordinate-descent sweep over five graph-construction knobs (lambda_1,
lambda_2, beam width, edge cap, co-occurrence weight), ordered by
sensitivity. Writeup includes Tier-2-only baseline row and graph-
contribution delta; structural-bug check (< 0.05 MRR lift) flags for
controller review before accepting any lambda change."
```

---

## Task 6 — Consolidation sweep (DEDUP_JACCARD, EXTRACT_MAX_TOKENS inspection)

**Objective:** Sweep `DEDUP_JACCARD_THRESHOLD` and inspect (not tune) `EXTRACT_MAX_TOKENS`.

**Why inspect, not tune, EXTRACT_MAX_TOKENS?** The harness seeder uses a rule-based fact extraction stub (Task 3 Step 3), not a real LLM. Token-cap behavior is only observable with live LLM calls, which are deferred to sub-phase 9.5. But the consolidation trace shape captures the drained batch size, dedup hit rate, and fact-count distribution — enough to reason about whether `EXTRACT_MAX_TOKENS` should be raised for the real-LLM sub-phase.

**Files:**

- Create: `bench/sweeps/consolidation.js`
- Modify: `package.json`

**Knobs:**

- `DEDUP_JACCARD_THRESHOLD`: [0.5, 0.6, 0.7, 0.8, 0.9]

5 points. Re-uses the Task 4 driver.

**Steps:**

1. Run the sweep. Record `added:updated` ratio per-point from consolidation traces.
2. Apply the Phase 6 retro rule: `<10% updates = too strict`, `>50% updates = too lax`.
3. Report:
   - Per-threshold `added/updated/dedupRate` table.
   - Recommended threshold at the point where updates are in the 20-40% band.
   - If the full sweep shows updates flat at <10% regardless of threshold (possible if the rule-based seeder rarely produces near-duplicates), write a sub-phase-9.5 note: "rule-based seeder can't exercise realistic dedup pressure; revisit with live LLM consolidation in sub-phase."
4. Write `docs/bench/sweeps/YYYY-MM-DD-consolidation.md` with a dedicated EXTRACT_MAX_TOKENS-inspection section (read-only: dumps per-extraction token counts, recommends cap).

**Commit:** mirror Tasks 4-5 pattern.

---

## Task 7 — BM25 sweep (TAG_BOOST, SUBJECT_BOOST)

**Objective:** Sweep the two integer boost multipliers. Phase 3 retro flagged these: "TAG_BOOST chose integer 2, not plan's fractional 1.5. If Phase 9 benchmarking shows tag matches outrank subject matches in unhelpful ways, this is the knob to tune — but it needs fractional support first, which means a refactor."

**Files:**

- Create: `bench/sweeps/bm25.js`
- Modify: `package.json`

**Knobs:**

- `TAG_BOOST`: [1, 2, 3, 4]  (integer only — fractional needs tokenizer refactor)
- `SUBJECT_BOOST`: [1, 2, 3, 4]

16 points. Full grid is fine at this size.

**Steps:**

1. Run the sweep.
2. Report per-(subject, tag) pair metrics.
3. If the elbow lies at `subject > tag` (subject matches dominate), flag as-expected. If `tag > subject`, flag as "investigate — suggests entries have bogus tags or subject-extraction is weak."
4. If Phase 3's hunch holds and fractional boosts would help, add a "v2.1 tokenizer refactor note" recommending a change to `src/retrieval/bm25.js` (replication → per-token weight multiplier).

**Commit:** mirror pattern.

---

## Task 8 — Baselines: naive BM25, recency, random

**Objective:** Ship three baseline retrievers and run them against the full harness. Establishes "how much does the ladder earn over the simplest possible retrieval?"

**Files:**

- Create: `bench/baselines/bm25only.js`  (bypass ladder, call Tier-2 directly)
- Create: `bench/baselines/recency.js`   (return top-K most recent entries, no scoring)
- Create: `bench/baselines/random.js`    (return K random entries, seeded for reproducibility)
- Create: `bench/baselines/index.js`     (barrel + `BASELINES` array)
- Create: `tests/unit/bench/baselines/*.test.js` (one per baseline)
- Modify: `bench/runner.js` — accept a `baseline` option that swaps the retrieval function
- Modify: `package.json` (add `bench:baselines`)

**Baseline contracts:**

All baselines implement `(chatId, query, { k }) => Array<{ id, content, score, tier: 'baseline' }>`. The runner treats `tier: 'baseline'` as a sentinel for metrics aggregation; traces get a `baselineId` field instead of a `scorerId`.

- `bm25only`: Build a transient BM25 index over every scope's entries (working + episodic + persona), return top-K. No classifier, no tier routing, no graph.
- `recency`: Sort all entries by `lifecycle.updatedAt` desc, return top-K. Pure recency.
- `random`: Seeded Mulberry32 PRNG (seed = `hash(chatId + query)` for reproducibility), return K random entries.

**Steps:**

1. Write tests for each baseline — determinism (same input → same output), k-respect, empty-state handling.
2. Implement baselines.
3. Modify `runner.js` to accept `baseline?: string` — if set, swap the retrieval function.
4. Run each baseline against full LoCoMo. Emit `docs/bench/baselines/YYYY-MM-DD-comparison.md` with:
   - Ladder vs bm25only vs recency vs random — precision@k, recall@k, MRR.
   - Latency comparison.
   - Per-category breakdown (factual vs relational vs temporal — LoCoMo QA items have a `category` field).

**Expected shape of result:**

- Random should be near-floor (p@1 ≈ 1/|entries|).
- Recency should perform poorly on factual queries, okay on "what did we talk about recently."
- bm25only should be competitive on factual queries but lose on relational (where Tier 3 earns its keep) and on popular queries (where Tier 0 cache + recency boost help).
- Ladder should dominate on MRR and recall@10.

If ladder is ≤bm25only on factual+relational QA combined, **that's a structural bug**, same STOP rule as the graph sweep.

**Commit:**

```bash
git add bench/baselines/ tests/unit/bench/baselines/ bench/runner.js \
        docs/bench/baselines/ package.json
git commit -m "feat(bench): three baselines — bm25only, recency, random

Baselines expose the same (chatId, query, { k }) signature as the
ladder; runner swaps via --baseline. Metrics aggregation groups by
baselineId when present, else scorerId.

Comparison report lands in docs/bench/baselines/. Ladder is expected
to dominate MRR and recall@10; underperformance vs bm25only on the
combined factual+relational QA slice triggers a structural-bug STOP
per the Phase 5 retro note on AdaMem ablation."
```

---

## Task 9 — Wire-invariant test + Phase 9 retro + ROADMAP append

**Objective:** Close the phase. Per Phase 8's lesson (entry-point wiring invariants), add a grep test asserting `bench/cli.js` wires up the three core symbols. Write the retro. Append to `ROADMAP.md` with measured values and Phase 10 handoff notes.

**Files:**

- Create: `tests/integration/bench/cli-mounts-wired.test.js` (grep invariant: `bench/cli.js` imports + calls `loadLocomo`, `runHarness`, `computeMetrics`; each sweep script imports + calls `sweep` + `runHarness`)
- Create: `docs/bench/baseline.json` (measured values from Tasks 4-7, machine-readable)
- Create: `docs/plans/phase-9-retro.md` (decisions held/revised, surprises, lessons)
- Modify: `docs/plans/ROADMAP.md` (append Phase 9 retro section, update status)
- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` (update §7, §5.2, §12.2 with measured values per the sweep recommendations — standalone `docs(spec)` commit, separate from the retro)

**Step 1 — Write the wire-invariant test**

Template from `tests/integration/integration/index-mounts-wired.test.js`. For each sweep/cli file, list the symbols it must import AND call. Tripwire-verify by deleting an import or a call site, confirm the test fails with a clear message, revert.

**Step 2 — Collect measured values into `docs/bench/baseline.json`**

Shape:

```json
{
  "asOf": "2026-04-XX",
  "gitSha": "...",
  "corpus": "locomo10",
  "tuned": {
    "TAU_CONFIDENCE": { "value": 2.5, "was": 2.0, "source": "sweeps/<date>-tau.md" },
    "TAU_GAP":         { "value": 0.75, "was": 0.5, "source": "sweeps/<date>-tau.md" },
    "LAMBDA_1":        { ... },
    ...
  },
  "headlineMetrics": {
    "ladder":   { "precisionAt5": 0.XX, "recallAt5": 0.XX, "mrr": 0.XX, "p95LatencyMs": XX },
    "bm25only": { ... },
    "recency":  { ... },
    "random":   { ... }
  }
}
```

**Step 3 — Write `phase-9-retro.md`**

Sections (mirror the Phase 6/7/8 retro structure from ROADMAP):

1. **What shipped** — terse list of D1-D10 from the plan header with actual counts.
2. **Decisions held/revised** — walk through Decisions 1-10; each gets "held" or "revised because <reason>." Anything revised gets a full paragraph.
3. **Execution mode** — subagent-driven or direct?; per-task audit notes.
4. **Surprises** — plan-drift bugs caught, sweep results that contradicted spec defaults, any STOP-triggered investigations.
5. **Notes for Phase 10** — what the Playwright harness should pick up; any uncovered benchmark territory (sub-phase 9.5 scope).

**Step 4 — Append to ROADMAP.md**

One new section `## Phase 9—YYYY-MM-DD` with subsections mirroring prior phases. Include a `Notes for Phase 10` subsection (not "Phase 9" anymore — we're past it).

**Step 5 — Spec amendment**

Standalone `docs(spec):` commit. For each measured knob whose value moved from the spec default:

- Update the relevant section of the spec to the measured value.
- Add a `**Measured 2026-04-XX against LoCoMo10**` note citing the sweep file.

Do NOT delete the original rationale — add the measurement alongside it. Future reviewers need to see both the design-time default and the measured value.

**Step 6 — Final verification**

```bash
npm run lint && npm run typecheck && npm test
```

All 58+ suites green. Test count should be ~680-700 (Phase 9 adds ~50-70 tests across loader, metrics, runner, sweeps, baselines, wire-invariant).

**Step 7 — Commit sequence (three commits)**

```bash
# 1. Wire invariant test + retro
git add tests/integration/bench/cli-mounts-wired.test.js \
        docs/plans/phase-9-retro.md
git commit -m "test(bench) + docs(plans): phase 9 wire invariant + retro"

# 2. Measured values
git add docs/bench/baseline.json
git commit -m "docs(bench): phase 9 measured baseline values"

# 3. ROADMAP
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 9 retro — measured, ladder vs baselines, notes for phase 10"

# 4. Spec (separate)
git add docs/specs/2026-04-20-starmem-v2-design.md
git commit -m "docs(spec): phase 9 measured knob values — per-section amendments"
```

---

## Verification matrix (referenced by Task 9's retro)

| ID  | Deliverable                              | Call site verified in                           |
|-----|------------------------------------------|-------------------------------------------------|
| V1  | `bench/cli.js` → `loadLocomo`            | `tests/integration/bench/cli-mounts-wired.test.js` |
| V2  | `bench/cli.js` → `computeMetrics`        | same                                             |
| V3  | `bench/cli.js` → `runHarness`            | same                                             |
| V4  | `bench/sweeps/tau.js` → `sweep`, `runHarness` | same                                        |
| V5  | `bench/sweeps/graph.js` → `sweep`, `runHarness` | same                                      |
| V6  | `bench/sweeps/consolidation.js` → `sweep`, `runHarness` | same                              |
| V7  | `bench/sweeps/bm25.js` → `sweep`, `runHarness`  | same                                      |
| V8  | Every baseline exercised by `bench/runner.js` | `tests/unit/bench/runner.test.js`             |
| V9  | `docs/bench/baseline.json` exists + valid JSON | `tests/integration/bench/baseline-json.test.js` (Task 9 Step 2) |
| V10 | `docs/plans/phase-9-retro.md` walks Decisions 1-10 | reviewed manually in Task 9 Step 3      |

---

## Remember

- **Bite-sized tasks** — each Task above is 2-6 sub-steps of 2-5 min focused work.
- **`write_file` for source**, `patch` for plan edits, heredoc for small prose chunks. Numeric literals in the plan: wrap with context or split lines so the secrets guard doesn't redact (Phase 6 retro).
- **STOP rules trigger controller review** — don't tune through structural bugs (graph sweep < 0.05 MRR lift, ladder ≤ bm25only).
- **Sweeps don't commit recommendations** — they emit writeups; controller accepts/rejects in Task 9.
- **Spec amendments are a separate commit** — never folded into feat or retro commits.

