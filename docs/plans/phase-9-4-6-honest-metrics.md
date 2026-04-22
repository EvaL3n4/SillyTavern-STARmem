# Sub-phase 9.4.6 — Honest Metrics (Evidence-Turn Matching + NaN Unscorables)

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Spec compliance review after each task, code quality review after spec passes. Proceed only when both reviews approve.

**Goal:** Replace `matchGold`'s text-Jaccard matching with `matchGoldByEvidence` (turn-index intersection between `entry.provenance.sourceMessages` and `qa.evidenceTurns`). Return NaN for unscorable queries. Aggregate via nanmean with `n_scored` / `n_skipped` surfaced separately. Unblocks 9.5 Tasks 5–10 with honest metric surfaces; removes the vacuous-truth shadow from all of Phase 9's published findings.

**Architecture:** `bench/metrics/retrieval.js:70-98` computes `matchedIds = Set<entryId>` via Jaccard over tokenized entry content vs. tokenized gold turn text with threshold `0.5`. This fails on virtually every query because the retrieved entries are LLM-synthesized facts (third-person, condensed, paraphrased) while gold turns are raw conversational dialogue — token overlap sits in the 0.1–0.3 range even for semantically correct retrievals. Empty `matchedIds` triggers `recallAtK:132`'s `return 1.0` default, producing the observed "recall=1.0, precision=0, mrr=0" pattern across every sweep point ever run in Phase 9. The bug is locked in by `tests/unit/bench/metrics/retrieval.test.js:124`, which asserts the vacuous behavior.

9.4.6 pivots the matcher entirely. Every LoCoMo QA carries `evidenceTurns: number[]` — the exact turn indices that contain the answer. Every entry carries `provenance.sourceMessages: number[]` — the turn indices the fact was extracted from. An entry "matches gold" iff those two arrays intersect. Zero thresholds, zero tokenization, zero extractor sensitivity.

**Tech Stack:** Node 25, ESM. Single dependency: `Number.isNaN` / `NaN` arithmetic semantics. No runtime deps added.

---

## Context: why this is 9.4.6, not a 9.5.X roll-in

Sub-phase 9.5 Task 5 (full-LoCoMo τ sweep re-run, post-9.4.5) produced a report in which all 48 points on 10 conversations × 1986 QA items yielded identical `recallAt5=1.0000 / precisionAt3=0.0000 / mrr=0.0000`. A crosscheck against the pre-9.4.5 rule-based τ artifact (renamed to `docs/bench/sweeps/2026-04-21-tau-rulebased-prefix.md`) showed the **identical** vacuous pattern — meaning Phase 9's original "flat sweep" finding was never a flat sweep. It was `matchGold` returning an empty `matchedIds` set on every single run, silently scored as perfect recall by `recallAtK`'s empty-set default. Elbow detection then picked the first grid corner because `Δmetric/Δknob = 0` everywhere — pure artifact.

The bug predates 9.4.5 and predates 9.5. It sits in the metrics layer and shadows every published Phase 9 finding, including `docs/bench/baseline.json`'s `headlineMetrics`, the four Phase-9 sweep artifacts, and the Phase 9 retro's "flat surface" narrative. Inserting 9.4.6 as a separate sub-phase (rather than rolling into 9.5 or amending Phase 9) keeps history honest — 9.4.5's determinism fix was correct and valuable on its own, and this is an independent remediation.

Per the `writing-plans` skill's "Insert an N.M.5 Sub-Phase When Smoke Reveals a Measurement-Blocking Contaminator" section (field-validated on 9.4.5), this is exactly the same pattern.

---

## Decisions locked before writing this plan (conversation 2026-04-22)

1. **Matcher strategy.** `evidenceTurns` intersection. Retrieved entry matches iff `entry.provenance.sourceMessages ∩ qa.evidenceTurns ≠ ∅`. No Jaccard, no threshold, no tokenization.
2. **Empty-match semantics.** When `matchedIds.size === 0` (either the QA has no gold, or nothing retrieved intersects it), all three metrics (precision@k, recall@k, MRR) return `NaN`. The old "return 1.0" vacuous behavior is deleted entirely.
3. **Aggregation.** `computeMetrics` uses nanmean: sum over non-NaN values, divide by count of non-NaN values. Surface both `n_scored` (queries that produced a real number) and `n_skipped` (queries that produced NaN) in `MetricsResult`. No hidden silent counts.
4. **Runner plumbing.** `bench/runner.js:108` currently projects `{id, content, score, tier}` off retrieved entries and drops `provenance.sourceMessages`. Plan includes a minimal passthrough add: `{id, content, sourceMessages, score, tier}`. No breaking change to the downstream shape consumed by baselines or sweep drivers.
5. **Scope — tests.** `tests/unit/bench/metrics/retrieval.test.js` needs surgical rewrites: the `recallAtK(new Set(), ranked, 2)` vacuous-case test is the bug itself and must be replaced with `expect(Number.isNaN(...)).toBe(true)`. Other tests are updated to use `matchGoldByEvidence` where they currently call `matchGold`.
6. **Scope — callers.** `bench/runner.js` (the only caller of `computeMetrics`) is updated to pass `qa.evidenceTurns` to the matcher via the existing `qa` field on run objects — already carried, no new plumbing. `bench/baselines.js`, `bench/sweeps/*.js` all consume the aggregated `MetricsResult` — they don't touch `matchGold` directly, so they get the fix transparently.
7. **Scope — preserved-but-deprecated.** Keep the old `matchGold` export for backward compatibility during Phase 10+ audit work (Phase 9's published numbers can be re-derived from the same log data). Mark with `@deprecated` JSDoc. Removal deferred to Phase 11 or later.
8. **Re-run scope after fix.** All four Phase 9.5 sweeps (τ, graph, consolidation, bm25) + the three baselines (bm25only, recency, random) + ladder, re-run on the warm extraction cache. Zero live LLM traffic — the cache is fully populated after the 9.5 Task 5 τ sweep (1164 entries, 4.6 MB). Runtime estimate: ~15 min × 4 sweeps ≈ 60 min total, CPU-bound.
9. **Baseline.json regeneration.** After re-run, 9.4.6 repopulates `docs/bench/baseline.json` with actual measured values and flips `status: "deferred"` → `status: "measured"`. Absorbs 9.5's Task 11 responsibility since the data is now honest.
10. **Retro shape.** Single `docs/plans/phase-9-4-6-retro.md`. Includes a "Shadow over Phase 9 findings" section acknowledging prior published numbers are vacuous and pointing at the honest replacements.

---

## Inherited contracts

- `bench/metrics/retrieval.js` exports `matchGold`, `precisionAtK`, `recallAtK`, `mrr`, `computeMetrics`, `DEFAULT_GOLD_THRESHOLD`, `STANDARD_K`. Post-9.4.6 adds `matchGoldByEvidence`. `matchGold` deprecated.
- `bench/runner.js` exports `runHarness({ corpus, scorerId, overrides, chatIdPrefix, onProgress, retriever })` returning `{ runs, metrics, envSnapshot }`. Post-9.4.6: `runs[].retrieved[]` carries `sourceMessages: number[]`.
- `bench/loaders/locomo.js` QAItem shape already includes `evidenceTurns: number[]` (verified in 9.5 prep). No loader change needed.
- `src/memory/entry.js` Entry shape includes `provenance.sourceMessages: number[]` (per spec §3.1). Set during `createEntry` from `provenance.sourceMessages` field, carried through consolidation + retrieval.
- `src/retrieval/ladder.js` `retrieve()` returns `{ entries: Entry[], ... }`. The `Entry` shape preserves `provenance.sourceMessages`. Verified.

---

## Task overview

| # | File(s) | What | Est. LOC |
|---|---|---|---|
| 0 | `docs/plans/phase-9-4-6-honest-metrics.md` | Plan file commit | — |
| 1 | `docs/bench/audits/2026-04-22-vacuous-metrics-audit.md` (new) | Confirm scope: enumerate every caller and every vacuous-case test | artifact |
| 2 | `bench/runner.js` | Pass `sourceMessages` through retrieved-entry projection | ~5 delta |
| 3 | `bench/metrics/retrieval.js`, `tests/unit/bench/metrics/retrieval.test.js` | `matchGoldByEvidence` + NaN semantics + nanmean aggregation; rewrite impacted tests | ~200 delta + 250 test delta |
| 4 | `docs/bench/sweeps/2026-04-22-*.md`, `docs/bench/baselines/2026-04-22-comparison.md` | Re-run 4 sweeps + 3 baselines + ladder on warm cache; write honest artifacts | artifacts |
| 5 | `docs/bench/baseline.json` | Replace `"deferred"` stub with measured values from Task 4 | ~80 delta |
| 6 | `docs/plans/phase-9-4-6-retro.md` (new) | Retro + Phase 9 shadow acknowledgement + 9.5 Tasks 6–10 handoff | artifact |

Plan size target: ~700 lines.

---

## Task 0: Commit the plan

**Objective:** Land this plan file so the rest of 9.4.6 has a stable reference.

**Files:**
- Commit: `docs/plans/phase-9-4-6-honest-metrics.md`

**Step 1: Tripwires**

```bash
wc -l docs/plans/phase-9-4-6-honest-metrics.md
grep -c "^## Task " docs/plans/phase-9-4-6-honest-metrics.md
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-9-4-6-honest-metrics.md || echo "(clean)"
```

Expected: ~700 lines, exactly 7 task headings (0–6), no secrets-guard redactions.

**Step 2: Commit**

```bash
git add docs/plans/phase-9-4-6-honest-metrics.md
git commit -m "docs(plans): sub-phase 9.4.6 honest metrics plan"
```

---

## Task 1: Vacuous-metrics audit

**Objective:** Before touching code, confirm (a) every caller of `matchGold` / `recallAtK` / `precisionAtK` / `mrr` / `computeMetrics`, (b) every test that encodes the vacuous-true behavior, (c) that no downstream tool depends on `recallAtK` returning 1.0 for empty `matchedIds`. Document in an audit artifact.

**Files:**
- Create: `docs/bench/audits/2026-04-22-vacuous-metrics-audit.md`

**Step 1: Enumerate callers**

```bash
grep -rn "\\bmatchGold\\b\|\\brecallAtK\\b\|\\bprecisionAtK\\b\|\\bcomputeMetrics\\b\|\\bmrr\\b" \
  bench/ tests/ --include='*.js' | grep -v "retrieval.js:" | sort
```

Classify each hit as:
- **Production caller** (bench/runner.js, bench/baselines.js): gets fix transparently
- **Test — direct metric call** (tests/unit/bench/metrics/retrieval.test.js): requires rewrite
- **Test — asserts aggregate shape** (other tests): requires spot-check only
- **Sweep driver** (bench/sweeps/*.js): consumes aggregated result; no direct matcher call

**Step 2: Identify vacuous-case tests**

```bash
grep -nE "(recallAtK\(.*Set\(\)|toBe\(1\.0\)|matchedIds\.size === 0)" \
  tests/unit/bench/metrics/retrieval.test.js
```

Expected hits:
- Line 124: `expect(recallAtK(new Set(), ranked, 2)).toBe(1.0);` — **this IS the bug; replace with NaN assertion**
- Line 116: `expect(recallAtK(matched, ranked, 3)).toBe(1.0);` — legitimate full-recall case (real matches present), leave alone
- Line 91: `expect(precisionAtK(matched, ranked, 1)).toBe(1.0);` — legitimate, leave alone
- Line 136: `expect(mrr(matched, ['a', 'b', 'c'])).toBe(1.0);` — legitimate, leave alone
- Line 208: `expect(result.mrr).toBe(1.0);` — legitimate computeMetrics over real runs, leave alone

**Step 3: Check for evidenceTurns coverage on LoCoMo**

Verify QAs actually carry evidence arrays we can intersect with:

```bash
head -c 2000 bench/.cache/locomo10.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
# locomo10 cache is top-level array of conversation samples
print('first sample keys:', list(data[0].keys())[:10])
print('first sample qa[0]:', json.dumps(data[0].get('qa', [{}])[0])[:200])
"
```

If QA items carry `evidence` as turn-id strings ("D1:S1:T3"), the loader's `parseEvidence()` already normalizes them to numeric `evidenceTurns` (verified at `bench/loaders/locomo.js:134`). If *any* QA in LoCoMo lacks evidence, it'll produce NaN — which is correct under 9.4.6 semantics.

**Step 4: Write the audit doc**

Create `docs/bench/audits/2026-04-22-vacuous-metrics-audit.md`:

```markdown
# Vacuous Metrics Audit — 2026-04-22

Ran before Task 3 of sub-phase 9.4.6 to confirm the scope of the fix.

## Impact

### Production callers of affected functions
(fill in from Step 1)

### Tests that encode the vacuous-true behavior
(fill in from Step 2)

### Sweep drivers and baselines consuming MetricsResult
(fill in from Step 1)

## LoCoMo evidenceTurns coverage
(fill in from Step 3; include counts of QAs with/without evidence)

## Summary

Fix lands in `bench/metrics/retrieval.js` + `bench/runner.js`. Transparent to sweep drivers, baselines, and CLI. Exactly `<N>` tests require direct rewrites.

Phase 9 published artifacts (baseline.json, 4 sweep md, retro) contain vacuous numbers and will be superseded by Task 4's re-runs. Historical artifacts preserved in-repo for provenance; `docs/plans/phase-9-4-6-retro.md` links the old files and their honest replacements.
```

**Step 5: Commit**

```bash
git add docs/bench/audits/2026-04-22-vacuous-metrics-audit.md
git commit -m "docs(bench): vacuous-metrics audit — scope the 9.4.6 fix"
```

---

## Task 2: Runner plumbing — pass sourceMessages through

**Objective:** Carry `entry.provenance.sourceMessages` into `run.retrieved[].sourceMessages`. One-line delta in the projection, plus a test that the field survives.

**Files:**
- Modify: `bench/runner.js` (around line 108)
- Modify: `tests/integration/bench/runner.integration.test.js` (verify passthrough)

**Pre-flight:**
```bash
grep -n "retrieved: result.entries.map" bench/runner.js
grep -nA 2 "retrieved:" tests/integration/bench/runner.integration.test.js
```

**Step 1: Write failing test**

Append to `tests/integration/bench/runner.integration.test.js` (near end of `describe('runHarness')`):

```javascript
    test('retrieved entries carry sourceMessages for evidence-turn matching', async () => {
        const result = await runHarness({ corpus: CORPUS });
        // At least one run should have non-empty retrieved with sourceMessages
        const runsWithRetrieved = result.runs.filter(r => r.retrieved.length > 0);
        expect(runsWithRetrieved.length).toBeGreaterThan(0);
        for (const run of runsWithRetrieved) {
            for (const entry of run.retrieved) {
                expect(Array.isArray(entry.sourceMessages)).toBe(true);
                expect(entry.sourceMessages.every(n => typeof n === 'number')).toBe(true);
            }
        }
    });
```

**Step 2: Run — expect fail**

```bash
npm test -- tests/integration/bench/runner.integration.test.js
```

Expected: FAIL — `expected true to be truthy` (sourceMessages is undefined).

**Step 3: Patch runner**

In `bench/runner.js` around line 108, the current projection:

```javascript
retrieved: result.entries.map(e => ({
    id: e.id,
    content: e.content ?? '',
    score,
    tier: result.tierResolved,
})),
```

Replace with:

```javascript
retrieved: result.entries.map(e => ({
    id: e.id,
    content: e.content ?? '',
    sourceMessages: e.provenance?.sourceMessages ?? [],
    score,
    tier: result.tierResolved,
})),
```

**Step 4: Run — expect pass**

```bash
npm test -- tests/integration/bench/runner.integration.test.js
npm test
npm run lint && npm run typecheck
```

Expected: full suite green.

**Step 5: Commit**

```bash
git add bench/runner.js tests/integration/bench/runner.integration.test.js
git commit -m "feat(bench): pass provenance.sourceMessages through runner projection (9.4.6 Task 2)"
```

---

## Task 3: Evidence-turn matcher + NaN semantics + nanmean aggregation

**Objective:** Add `matchGoldByEvidence`, rewrite `precisionAtK` / `recallAtK` / `mrr` to return NaN on empty `matchedIds`, rewrite `computeMetrics` to nanmean and surface `n_scored` / `n_skipped`. Deprecate `matchGold`. Rewrite the impacted unit tests.

**Files:**
- Modify: `bench/metrics/retrieval.js`
- Modify: `tests/unit/bench/metrics/retrieval.test.js`

**Pre-flight:**
```bash
wc -l bench/metrics/retrieval.js tests/unit/bench/metrics/retrieval.test.js
grep -n "export " bench/metrics/retrieval.js
```

Expected: `retrieval.js` ~205 lines, ~6 exports; test file ~210 lines.

**Step 1: Write failing tests**

Replace the contents of `tests/unit/bench/metrics/retrieval.test.js`. (Full verbatim rewrite — the existing file encodes the vacuous behavior, so surgical patching is more error-prone than a clean replacement.)

```javascript
import { describe, test, expect } from '@jest/globals';
import {
    matchGoldByEvidence,
    precisionAtK,
    recallAtK,
    mrr,
    computeMetrics,
    STANDARD_K,
} from '../../../../bench/metrics/retrieval.js';

describe('matchGoldByEvidence', () => {
    test('matches when entry.sourceMessages intersects qa.evidenceTurns', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
            { id: 'b', content: 'y', sourceMessages: [10], score: 0.5 },
        ];
        const evidenceTurns = [3, 7];
        const result = matchGoldByEvidence(retrieved, evidenceTurns);
        expect(result.matchedIds).toEqual(new Set(['a']));
    });

    test('non-intersection → empty matchedIds', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
        ];
        const result = matchGoldByEvidence(retrieved, [10, 20]);
        expect(result.matchedIds.size).toBe(0);
    });

    test('empty evidenceTurns → empty matchedIds', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
        ];
        const result = matchGoldByEvidence(retrieved, []);
        expect(result.matchedIds.size).toBe(0);
    });

    test('missing sourceMessages on entry → that entry does not match', () => {
        const retrieved = [
            { id: 'a', content: 'x', score: 1 }, // no sourceMessages
            { id: 'b', content: 'y', sourceMessages: [3], score: 0.5 },
        ];
        const result = matchGoldByEvidence(retrieved, [3]);
        expect(result.matchedIds).toEqual(new Set(['b']));
    });

    test('populates perGold map', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 5], score: 1 },
            { id: 'b', content: 'y', sourceMessages: [5, 7], score: 0.5 },
        ];
        const result = matchGoldByEvidence(retrieved, [3, 5, 9]);
        expect(result.perGold[3]).toEqual(['a']);
        expect(result.perGold[5]).toEqual(expect.arrayContaining(['a', 'b']));
        expect(result.perGold[9]).toBeUndefined();
    });
});

describe('precisionAtK', () => {
    test('hits in top-k', () => {
        const matched = new Set(['a', 'c']);
        const ranked = ['a', 'b', 'c', 'd'];
        expect(precisionAtK(matched, ranked, 3)).toBeCloseTo(2 / 3);
    });

    test('no hits', () => {
        expect(precisionAtK(new Set(['x']), ['a', 'b'], 2)).toBe(0);
    });

    test('empty matchedIds → NaN (unscorable)', () => {
        expect(Number.isNaN(precisionAtK(new Set(), ['a', 'b'], 2))).toBe(true);
    });

    test('empty rankedIds → 0 (retrieval returned nothing, not unscorable)', () => {
        expect(precisionAtK(new Set(['a']), [], 3)).toBe(0);
    });
});

describe('recallAtK', () => {
    test('all matched in top-k', () => {
        const matched = new Set(['a', 'b']);
        const ranked = ['a', 'b', 'c'];
        expect(recallAtK(matched, ranked, 3)).toBe(1.0);
    });

    test('partial recall', () => {
        const matched = new Set(['a', 'b']);
        const ranked = ['a', 'c', 'd'];
        expect(recallAtK(matched, ranked, 3)).toBe(0.5);
    });

    test('empty matchedIds → NaN (unscorable — was 1.0 vacuous pre-9.4.6)', () => {
        expect(Number.isNaN(recallAtK(new Set(), ['a', 'b'], 2))).toBe(true);
    });

    test('no hits in top-k', () => {
        expect(recallAtK(new Set(['a']), ['b', 'c'], 2)).toBe(0);
    });
});

describe('mrr', () => {
    test('first hit at rank 1', () => {
        expect(mrr(new Set(['a']), ['a', 'b', 'c'])).toBe(1.0);
    });

    test('first hit at rank 3', () => {
        expect(mrr(new Set(['c']), ['a', 'b', 'c'])).toBeCloseTo(1 / 3);
    });

    test('no hit', () => {
        expect(mrr(new Set(['x']), ['a', 'b', 'c'])).toBe(0);
    });

    test('empty matchedIds → NaN', () => {
        expect(Number.isNaN(mrr(new Set(), ['a', 'b']))).toBe(true);
    });
});

describe('computeMetrics with NaN aggregation', () => {
    test('basic run with evidence match', () => {
        const runs = [{
            retrieved: [
                { id: 'a', content: 'x', sourceMessages: [3], score: 1 },
                { id: 'b', content: 'y', sourceMessages: [99], score: 0.5 },
            ],
            qa: { evidenceTurns: [3] },
        }];
        const result = computeMetrics(runs);
        expect(result.n).toBe(1);
        expect(result.n_scored).toBe(1);
        expect(result.n_skipped).toBe(0);
        expect(result.recallAtK[5]).toBe(1.0); // a is matched and in top-5
        expect(result.mrr).toBe(1.0);
    });

    test('unscorable runs contribute NaN and are excluded from mean', () => {
        const runs = [
            {
                // Scorable: matched 'a' at rank 1
                retrieved: [{ id: 'a', content: 'x', sourceMessages: [3], score: 1 }],
                qa: { evidenceTurns: [3] },
            },
            {
                // Unscorable: no evidence intersects
                retrieved: [{ id: 'b', content: 'y', sourceMessages: [99], score: 0.5 }],
                qa: { evidenceTurns: [3] },
            },
        ];
        const result = computeMetrics(runs);
        expect(result.n).toBe(2);
        expect(result.n_scored).toBe(1);
        expect(result.n_skipped).toBe(1);
        expect(result.mrr).toBe(1.0); // averaged over the 1 scored run
        expect(result.recallAtK[5]).toBe(1.0);
    });

    test('all unscorable → NaN metrics, n_skipped=n', () => {
        const runs = [{
            retrieved: [{ id: 'a', content: 'x', sourceMessages: [99], score: 1 }],
            qa: { evidenceTurns: [3] },
        }];
        const result = computeMetrics(runs);
        expect(result.n).toBe(1);
        expect(result.n_scored).toBe(0);
        expect(result.n_skipped).toBe(1);
        expect(Number.isNaN(result.mrr)).toBe(true);
        for (const k of STANDARD_K) {
            expect(Number.isNaN(result.precisionAtK[k])).toBe(true);
            expect(Number.isNaN(result.recallAtK[k])).toBe(true);
        }
    });

    test('empty runs → n=0, n_scored=0, NaN metrics', () => {
        const result = computeMetrics([]);
        expect(result.n).toBe(0);
        expect(result.n_scored).toBe(0);
        expect(result.n_skipped).toBe(0);
        expect(Number.isNaN(result.mrr)).toBe(true);
        for (const k of STANDARD_K) {
            expect(Number.isNaN(result.recallAtK[k])).toBe(true);
        }
    });

    test('aggregates over multiple scorable runs', () => {
        const runs = [
            {
                retrieved: [
                    { id: 'a', content: 'x', sourceMessages: [3], score: 1 },
                    { id: 'c', content: 'z', sourceMessages: [99], score: 0.5 },
                ],
                qa: { evidenceTurns: [3] },
            },
            {
                retrieved: [
                    { id: 'b', content: 'y', sourceMessages: [99], score: 1 },
                    { id: 'd', content: 'w', sourceMessages: [7], score: 0.5 },
                ],
                qa: { evidenceTurns: [7] },
            },
        ];
        const result = computeMetrics(runs);
        expect(result.n_scored).toBe(2);
        // Run 1: mrr=1.0 (rank 1); Run 2: mrr=0.5 (rank 2)
        expect(result.mrr).toBeCloseTo(0.75);
    });
});
```

**Step 2: Run — expect fail**

```bash
npm test -- tests/unit/bench/metrics/retrieval.test.js
```

Expected: FAILs across the board — `matchGoldByEvidence` not exported; precision/recall/mrr return 0/1.0 instead of NaN.

**Step 3: Rewrite `bench/metrics/retrieval.js`**

Full replacement (preserves legacy `matchGold` + `jaccard` + `DEFAULT_GOLD_THRESHOLD` as deprecated):

```javascript
/**
 * Retrieval metrics: precision@k, recall@k, MRR.
 *
 * As of sub-phase 9.4.6, gold matching uses turn-index intersection
 * (matchGoldByEvidence) rather than text Jaccard (matchGold — deprecated).
 * The legacy matcher is preserved for provenance but is not wired into
 * computeMetrics.
 *
 * Unscorable queries (empty matchedIds) return NaN. computeMetrics
 * aggregates via nanmean and surfaces n_scored / n_skipped separately.
 *
 * @module bench/metrics/retrieval
 * @see docs/plans/phase-9-4-6-honest-metrics.md
 */

import { tokenize } from '../../src/retrieval/bm25.js';

/** @type {number} @deprecated Used only by legacy matchGold. */
export const DEFAULT_GOLD_THRESHOLD = 0.5;

/** @type {number[]} */
export const STANDARD_K = [1, 3, 5, 10];

/**
 * @typedef {object} RetrievedEntry
 * @property {string} id
 * @property {string} content
 * @property {number[]} [sourceMessages]  - post-9.4.6; carried by runner.js
 * @property {number} score
 */

/**
 * @typedef {object} MatchGoldResult
 * @property {Set<string>} matchedIds
 * @property {Record<number, string[]>} perGold
 */

/**
 * @typedef {object} QAWithEvidence
 * @property {number[]} evidenceTurns
 */

/**
 * @typedef {object} Run
 * @property {RetrievedEntry[]} retrieved
 * @property {QAWithEvidence} qa
 */

/**
 * @typedef {object} MetricsResult
 * @property {number} n              - Total run count.
 * @property {number} n_scored       - Runs that produced numeric metrics.
 * @property {number} n_skipped      - Runs that produced NaN (empty matchedIds).
 * @property {Record<number, number>} precisionAtK  - NaN if n_scored === 0.
 * @property {Record<number, number>} recallAtK     - NaN if n_scored === 0.
 * @property {number} mrr            - NaN if n_scored === 0.
 */

/**
 * Jaccard similarity over token arrays. Preserved for the deprecated
 * matchGold path; do not use in new code.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 * @deprecated 9.4.6 — evidence-turn intersection replaces text-Jaccard matching.
 */
export function jaccard(a, b) {
    if (a.length === 0 && b.length === 0) return 1;
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Legacy text-Jaccard gold matcher. Vacuously matches nothing on LLM-synthesized
 * facts vs raw gold turn text — the primary cause of Phase 9's "flat sweep"
 * artifact. Kept for historical audit only.
 *
 * @param {RetrievedEntry[]} retrieved
 * @param {{turnIndex: number, text: string}[]} goldTurns
 * @param {{ threshold?: number }} [opts]
 * @returns {MatchGoldResult}
 * @deprecated 9.4.6 — use matchGoldByEvidence.
 */
export function matchGold(retrieved, goldTurns, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_GOLD_THRESHOLD;
    const matchedIds = new Set();
    const perGold = {};

    const goldTokens = goldTurns.map(g => ({
        turnIndex: g.turnIndex,
        tokens: tokenize(g.text),
    }));

    for (const entry of retrieved) {
        const entryTokens = tokenize(entry.content);
        for (const gold of goldTokens) {
            if (jaccard(entryTokens, gold.tokens) >= threshold) {
                matchedIds.add(entry.id);
                if (!perGold[gold.turnIndex]) perGold[gold.turnIndex] = [];
                perGold[gold.turnIndex].push(entry.id);
            }
        }
    }

    return { matchedIds, perGold };
}

/**
 * Evidence-turn gold matcher. A retrieved entry matches iff its
 * provenance.sourceMessages (carried as entry.sourceMessages by
 * bench/runner.js) intersects the QA's evidenceTurns. Zero heuristics,
 * zero threshold, zero tokenization.
 *
 * @param {RetrievedEntry[]} retrieved
 * @param {number[]} evidenceTurns
 * @returns {MatchGoldResult}
 */
export function matchGoldByEvidence(retrieved, evidenceTurns) {
    const matchedIds = new Set();
    /** @type {Record<number, string[]>} */
    const perGold = {};

    if (!Array.isArray(evidenceTurns) || evidenceTurns.length === 0) {
        return { matchedIds, perGold };
    }

    const evidenceSet = new Set(evidenceTurns);

    for (const entry of retrieved) {
        const srcs = entry.sourceMessages;
        if (!Array.isArray(srcs) || srcs.length === 0) continue;

        for (const src of srcs) {
            if (evidenceSet.has(src)) {
                matchedIds.add(entry.id);
                if (!perGold[src]) perGold[src] = [];
                if (!perGold[src].includes(entry.id)) perGold[src].push(entry.id);
            }
        }
    }

    return { matchedIds, perGold };
}

/**
 * Precision@k. Returns NaN when matchedIds is empty (unscorable QA —
 * no gold exists for this query or no retrieval intersected it).
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(matchedIds, rankedIds, k) {
    if (matchedIds.size === 0) return NaN;
    if (rankedIds.length === 0) return 0;
    const top = rankedIds.slice(0, k);
    let hits = 0;
    for (const id of top) if (matchedIds.has(id)) hits++;
    return hits / top.length;
}

/**
 * Recall@k. Returns NaN when matchedIds is empty (unscorable).
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function recallAtK(matchedIds, rankedIds, k) {
    if (matchedIds.size === 0) return NaN;
    const top = new Set(rankedIds.slice(0, k));
    let hits = 0;
    for (const id of matchedIds) if (top.has(id)) hits++;
    return hits / matchedIds.size;
}

/**
 * Mean Reciprocal Rank. Returns NaN when matchedIds is empty (unscorable).
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @returns {number}
 */
export function mrr(matchedIds, rankedIds) {
    if (matchedIds.size === 0) return NaN;
    for (let i = 0; i < rankedIds.length; i++) {
        if (matchedIds.has(rankedIds[i])) return 1 / (i + 1);
    }
    return 0;
}

/**
 * Aggregate precision@k, recall@k, and MRR over a batch of runs.
 * Uses nanmean: sum of non-NaN contributions divided by count of non-NaN
 * contributions. Reports n_scored / n_skipped alongside values for honesty.
 *
 * @param {Run[]} runs
 * @param {{ kValues?: number[] }} [opts]
 * @returns {MetricsResult}
 */
export function computeMetrics(runs, opts = {}) {
    const kValues = opts.kValues ?? STANDARD_K;

    /** @type {Record<number, number>} */
    const precisionSums = {};
    /** @type {Record<number, number>} */
    const recallSums = {};
    /** @type {Record<number, number>} */
    const precisionCounts = {};
    /** @type {Record<number, number>} */
    const recallCounts = {};
    let mrrSum = 0;
    let mrrCount = 0;

    for (const k of kValues) {
        precisionSums[k] = 0;
        recallSums[k] = 0;
        precisionCounts[k] = 0;
        recallCounts[k] = 0;
    }

    let n_scored = 0;
    let n_skipped = 0;

    for (const run of runs) {
        const evidenceTurns = run.qa?.evidenceTurns ?? [];
        const { matchedIds } = matchGoldByEvidence(run.retrieved, evidenceTurns);
        const rankedIds = run.retrieved.map(r => r.id);

        if (matchedIds.size === 0) {
            n_skipped++;
            continue;
        }
        n_scored++;

        for (const k of kValues) {
            const p = precisionAtK(matchedIds, rankedIds, k);
            if (!Number.isNaN(p)) { precisionSums[k] += p; precisionCounts[k]++; }
            const r = recallAtK(matchedIds, rankedIds, k);
            if (!Number.isNaN(r)) { recallSums[k] += r; recallCounts[k]++; }
        }
        const m = mrr(matchedIds, rankedIds);
        if (!Number.isNaN(m)) { mrrSum += m; mrrCount++; }
    }

    /** @type {Record<number, number>} */
    const precisionResult = {};
    /** @type {Record<number, number>} */
    const recallResult = {};
    for (const k of kValues) {
        precisionResult[k] = precisionCounts[k] > 0 ? precisionSums[k] / precisionCounts[k] : NaN;
        recallResult[k] = recallCounts[k] > 0 ? recallSums[k] / recallCounts[k] : NaN;
    }

    return {
        n: runs.length,
        n_scored,
        n_skipped,
        precisionAtK: precisionResult,
        recallAtK: recallResult,
        mrr: mrrCount > 0 ? mrrSum / mrrCount : NaN,
    };
}
```

**Step 4: Run the test — expect pass**

```bash
npm test -- tests/unit/bench/metrics/retrieval.test.js
```

Expected: all tests pass.

**Step 5: Full suite**

```bash
npm test
```

Expected: all green. Sweep drivers and baselines consume `MetricsResult` positionally — the added `n_scored` / `n_skipped` fields don't break anything. NaN values in reports may render as `"NaN"` in Markdown — acceptable signal, not a bug.

If any test breaks because it asserts the old vacuous shape on a downstream aggregate (e.g. `result.recallAtK[5]` specifically being 1.0), check whether it's testing aggregate shape (fix: use `.toBeCloseTo` with real numbers; or update to assert `Number.isNaN`) or the CLI/driver JSONL shape (fix: add `n_scored` / `n_skipped` to expected shape).

Known candidate: `tests/unit/bench/sweeps/driver.test.js:35` constructs a fake `MetricsResult`. Update to include `n_scored` + `n_skipped`.

**Step 6: Lint + typecheck**

```bash
npm run lint && npm run typecheck
```

**Step 7: Update bench/metrics/index.js re-exports**

```bash
grep -n "export " bench/metrics/index.js
```

If the barrel re-exports the metric functions individually, add `matchGoldByEvidence` to the list. If it `export *`s from retrieval.js, nothing to do.

**Step 8: Commit**

```bash
git add bench/metrics/retrieval.js tests/unit/bench/metrics/retrieval.test.js \
    tests/unit/bench/sweeps/driver.test.js bench/metrics/index.js 2>/dev/null
git commit -m "feat(bench): evidence-turn gold matcher + NaN unscorable semantics (9.4.6 Task 3)

Replace vacuous text-Jaccard matching with evidence-turn intersection.
A retrieved entry matches gold iff entry.sourceMessages intersects
qa.evidenceTurns. Zero heuristics, zero threshold.

Empty matchedIds (no evidence or no retrieval intersection) now returns
NaN across precision@k, recall@k, MRR. computeMetrics nanmeans the
results and surfaces n_scored / n_skipped so the caller can see the
honest denominator.

Phase 9's published metrics (recall=1.0 everywhere, precision=mrr=0.0
everywhere) were all artifacts of the old matchGold failing silently +
recallAtK's 'empty matchedIds → 1.0' default. The old matchGold /
jaccard / DEFAULT_GOLD_THRESHOLD exports are preserved as @deprecated
for historical provenance."
```

---

## Task 4: Re-run all Phase 9 sweeps + baselines on warm cache

**Objective:** Produce honest sweep artifacts (τ, graph, consolidation, bm25), re-run the three baselines (bm25only, recency, random) plus the default ladder retriever, and land all results under `docs/bench/sweeps/2026-04-22-*.md` and `docs/bench/baselines/2026-04-22-*.md`.

**Files:**
- Create: `docs/bench/sweeps/2026-04-22-tau-live.md`
- Create: `docs/bench/sweeps/2026-04-22-graph-live.md`
- Create: `docs/bench/sweeps/2026-04-22-consolidation-live.md`
- Create: `docs/bench/sweeps/2026-04-22-bm25-live.md`
- Create: `docs/bench/baselines/2026-04-22-comparison-live.md`

**Pre-flight:**
```bash
ls bench/.cache/extractions/ | wc -l   # expect ~1164 (full-LoCoMo warm cache)
du -sh bench/.cache/extractions/        # expect ~4.6M
grep "Report written to" /tmp/starmem-logs/tau-live.log | tail -1
```

Expected: cache populated from the 9.5 Task 5 tau sweep that ran overnight; Report-written marker confirms the cache closed cleanly.

**Step 1: Move the vacuous 9.5 Task 5 artifact aside**

```bash
mv docs/bench/sweeps/2026-04-21-tau.md \
   docs/bench/sweeps/2026-04-21-tau-VACUOUS-pre-9-4-6.md
```

(The renamed file stays on disk as historical provenance; not committed since it was untracked, but preserved so Task 6's retro can reference it.)

**Step 2: Run all four sweeps**

Each sweep re-seeds all 10 conversations per grid point (warm cache → replay, no LLM traffic). Default filenames land at `docs/bench/sweeps/YYYY-MM-DD-{tau,graph,consolidation,bm25}.md`. Ran one at a time to avoid jest flake from concurrent CPU (per field-validated pattern in `subagent-driven-development` skill).

```bash
# 2a. τ sweep (8 × 6 = 48 points)
set -a; . ./.env.bench; set +a
node bench/sweeps/tau.js --conversations 10 2>&1 | tee /tmp/starmem-logs/9-4-6-tau.log | tail -20

# 2b. graph sweep
node bench/sweeps/graph.js --conversations 10 2>&1 | tee /tmp/starmem-logs/9-4-6-graph.log | tail -20

# 2c. consolidation sweep
node bench/sweeps/consolidation.js --conversations 10 2>&1 | tee /tmp/starmem-logs/9-4-6-consolidation.log | tail -20

# 2d. bm25 sweep
node bench/sweeps/bm25.js --conversations 10 2>&1 | tee /tmp/starmem-logs/9-4-6-bm25.log | tail -20
```

Wall time per sweep: seed phase replays ~328 cached extractions × 10 convs = ~20 s/point cold on first; points 2..N reuse the in-process state. If a sweep driver re-seeds per point, longer — up to ~10 min per sweep. 40 min total worst case.

After each sweep, verify:
```bash
head -30 docs/bench/sweeps/2026-04-22-*.md | grep -E "n_scored|n_skipped|recall|mrr"
```

Expect real numbers (not 1.0000 everywhere), non-zero `n_skipped` (expected — some QAs lack evidence or retrieval misses them), and variation across sweep points.

**Step 3: Rename sweep artifacts with `-live` suffix**

```bash
for s in tau graph consolidation bm25; do
  mv "docs/bench/sweeps/2026-04-22-${s}.md" \
     "docs/bench/sweeps/2026-04-22-${s}-live.md"
done
ls docs/bench/sweeps/2026-04-22-*
```

**Step 4: Run the baseline comparison**

```bash
node bench/baselines.js --conversations 10 2>&1 | tee /tmp/starmem-logs/9-4-6-baselines.log | tail -30
```

Expected output format: for each baseline (bm25only, recency, random) + ladder, a `MetricsResult` row with recall@{1,3,5,10}, mrr, p95 latency, n_scored, n_skipped.

The invariant to check (per Phase 9.5 Decision 8):
- `ladder_mrr ≥ bm25only_mrr − 0.02` on full LoCoMo

If `bm25only_mrr > ladder_mrr + 0.02`, the scorer chain isn't earning its keep on this corpus. That's a **finding**, not a plan failure — it means Phase 11 needs to look at scorer weights. Document in Step 5.

**Step 5: Write the baseline comparison doc**

Create `docs/bench/baselines/2026-04-22-comparison-live.md`:

```markdown
# Baseline comparison — 2026-04-22 (post-9.4.6 honest metrics)

**Corpus:** 10 conversations, ~1986 QA items
**Extractor:** google/gemma-4-26b-a4b-it via LiteLLM (warm cache, zero live calls)
**Matcher:** evidenceTurns intersection (sub-phase 9.4.6)

## Results

| Retriever | recall@1 | recall@3 | recall@5 | recall@10 | mrr | p95 latency ms | n_scored | n_skipped |
|---|---|---|---|---|---|---|---|---|
| ladder    | ... | ... | ... | ... | ... | ... | ... | ... |
| bm25only  | ... | ... | ... | ... | ... | ... | ... | ... |
| recency   | ... | ... | ... | ... | ... | ... | ... | ... |
| random    | ... | ... | ... | ... | ... | ... | ... | ... |

## Structural invariant (Phase 9.5 Decision 8)

- `ladder_mrr ≥ bm25only_mrr − 0.02`: **[PASS | FLAG]**
- Measured delta (ladder − bm25only): `...`
- Interpretation: ...

## n_scored denominator

Of 1986 QA items, `...` produced numeric metrics; `...` were skipped.
Skip reasons:
- QAs with empty `evidenceTurns`: ...
- QAs where retrieval produced no evidence-intersecting entry: ...

If n_skipped > ~15% of total, flag for Phase 11: either the retriever is
missing the evidence turn entirely (semantic gap) or the consolidation
pipeline is losing the source-message attribution on those extractions.
```

Fill in measured values.

**Step 6: Commit everything**

```bash
git add docs/bench/sweeps/2026-04-22-*-live.md \
        docs/bench/baselines/2026-04-22-comparison-live.md
git commit -m "docs(bench): 9.4.6 honest-metrics sweeps + baseline comparison

Full-LoCoMo (10 conv, 1986 QA) re-runs of tau, graph, consolidation, bm25
sweeps plus baseline comparison (ladder, bm25only, recency, random).
All artifacts carry n_scored / n_skipped denominators for honesty.

Supersedes pre-9.4.6 artifacts (docs/bench/sweeps/2026-04-21-*.md and
2026-04-21-tau-VACUOUS-pre-9-4-6.md) which contained vacuous metrics
from the text-Jaccard matcher bug. Old files preserved in-tree for
provenance; not referenced by baseline.json going forward."
```

---

## Task 5: Populate baseline.json

**Objective:** Replace `docs/bench/baseline.json`'s `"deferred"` stub with measured values from Task 4.

**Files:**
- Modify: `docs/bench/baseline.json`

**Step 1: Gather measured values**

From the sweep Markdown docs' "Elbow" sections, extract per-knob measured values. From `docs/bench/baselines/2026-04-22-comparison-live.md`, extract the ladder row into `headlineMetrics`.

**Step 2: Rewrite baseline.json**

```json
{
  "asOf": "2026-04-22",
  "gitSha": "<HEAD sha after Task 4 commits>",
  "corpus": "locomo10-full",
  "nodeVersion": "v25.9.0",
  "scorerId": "default",
  "status": "measured",
  "tuned": {
    "TIER2_TAU_CONFIDENCE":     { "specDefault": 2.0, "measured": <n>, "source": "sweeps/2026-04-22-tau-live.md",           "note": "..." },
    "TIER2_TAU_GAP":            { "specDefault": 0.5, "measured": <n>, "source": "sweeps/2026-04-22-tau-live.md",           "note": "..." },
    "TIER3_LAMBDA_1":           { "specDefault": 1.0, "measured": <n>, "source": "sweeps/2026-04-22-graph-live.md",         "note": "..." },
    "TIER3_LAMBDA_2":           { "specDefault": 0.3, "measured": <n>, "source": "sweeps/2026-04-22-graph-live.md",         "note": "..." },
    "TIER3_BEAM_WIDTH":         { "specDefault": 5,   "measured": <n>, "source": "sweeps/2026-04-22-graph-live.md",         "note": "..." },
    "EDGE_CAP_PER_ENTRY":       { "specDefault": 20,  "measured": <n>, "source": "sweeps/2026-04-22-graph-live.md",         "note": "..." },
    "COOCCURRENCE_WEIGHT":      { "specDefault": 0.5, "measured": <n>, "source": "sweeps/2026-04-22-graph-live.md",         "note": "..." },
    "DEDUP_JACCARD_THRESHOLD":  { "specDefault": 0.7, "measured": <n>, "source": "sweeps/2026-04-22-consolidation-live.md", "note": "..." },
    "TAG_BOOST":                { "specDefault": 2,   "measured": <n>, "source": "sweeps/2026-04-22-bm25-live.md",          "note": "..." },
    "SUBJECT_BOOST":            { "specDefault": 2,   "measured": <n>, "source": "sweeps/2026-04-22-bm25-live.md",          "note": "..." }
  },
  "headlineMetrics": {
    "corpus": "locomo10-full (1986 QA items, n_scored=<m>, n_skipped=<s>)",
    "ladder":   { "recallAt1": <n>, "recallAt5": <n>, "mrr": <n>, "p95LatencyMs": <n> },
    "bm25only": { "recallAt1": <n>, "recallAt5": <n>, "mrr": <n>, "p95LatencyMs": <n> },
    "recency":  { "recallAt1": <n>, "recallAt5": <n>, "mrr": <n>, "p95LatencyMs": <n> },
    "random":   { "recallAt1": <n>, "recallAt5": <n>, "mrr": <n>, "p95LatencyMs": <n> }
  },
  "structuralInvariants": {
    "ladderVsRandom":   { "threshold": 0.02, "measuredMrrDelta": <n>, "status": "<pass|flag>", "note": "..." },
    "ladderVsBm25Only": { "threshold": 0.02, "measuredMrrDelta": <n>, "status": "<pass|flag>", "note": "..." }
  }
}
```

**Step 3: Validate with the baseline-json validator**

```bash
npm test -- tests/integration/bench/baseline-validator.test.js
```

Expected: green. If validator test existed only for the `deferred` shape, update it to accept `measured`.

**Step 4: Commit**

```bash
git add docs/bench/baseline.json
git commit -m "docs(bench): populate baseline.json with 9.4.6 measured values

Absorbs Phase 9.5 Task 11's responsibility. Status flips deferred →
measured. Every measured field references a 2026-04-22 sweep artifact
with honest NaN-aware aggregation."
```

---

## Task 6: Retro + 9.5 handoff + Phase 9 shadow acknowledgement

**Objective:** Document the finding, the fix, the shadow over Phase 9's published numbers, and the handoff back to 9.5 Tasks 6–10.

**Files:**
- Create: `docs/plans/phase-9-4-6-retro.md`

**Step 1: Write the retro**

Create `docs/plans/phase-9-4-6-retro.md`:

```markdown
# Sub-phase 9.4.6 Retro — Honest Metrics

**Status:** Complete.
**Commits:** [list]

## What happened

Phase 9.5 Task 5 produced a τ sweep report where every one of 48 points on 10 conversations / 1986 QA items returned recallAt5=1.0000, precisionAt3=0.0000, mrr=0.0000. Under correct IR semantics this is impossible — recall=1.0 requires at least one hit, which would give precision>0 and MRR≥1/k. Investigation traced to two compounding bugs:

1. **`matchGold` vacuous-match.** `bench/metrics/retrieval.js:70` used text-Jaccard with threshold 0.5 between LLM-synthesized fact entries and raw gold turn text. Token overlap for rephrased third-person facts vs dialogue sits at 0.1–0.3 — nowhere near 0.5 — so `matchedIds` was empty on every query.
2. **`recallAtK` silent-default.** `recallAtK:132` returned `1.0` when `matchedIds.size === 0`, codified by `tests/unit/bench/metrics/retrieval.test.js:124`. The empty-set vacuous-true antipattern turned every zero-match into perfect-recall.

Both bugs existed before Phase 9 Task 8 (baselines) shipped. Every Phase 9 sweep artifact, the baseline comparison, `baseline.json`, and the Phase 9 retro's "flat surface" finding are downstream of the same bug.

## Shadow over Phase 9 findings

Artifacts that reported vacuous numbers:
- `docs/bench/sweeps/2026-04-21-tau.md` (renamed to `-VACUOUS-pre-9-4-6.md`)
- `docs/bench/sweeps/2026-04-21-tau-rulebased-prefix.md`
- `docs/bench/sweeps/2026-04-21-graph.md`
- `docs/bench/sweeps/2026-04-21-consolidation.md`
- `docs/bench/sweeps/2026-04-21-bm25.md`
- `docs/bench/baseline.json` (prior "deferred" state was honest — measured fields were null; the vacuous-status was what triggered 9.5)
- `docs/plans/phase-9-retro.md` — "flat surface / specDefaults hold" narrative is now moot. The surfaces may actually have elbows; we just couldn't see them.

Honest replacements:
- `docs/bench/sweeps/2026-04-22-tau-live.md`
- `docs/bench/sweeps/2026-04-22-graph-live.md`
- `docs/bench/sweeps/2026-04-22-consolidation-live.md`
- `docs/bench/sweeps/2026-04-22-bm25-live.md`
- `docs/bench/baselines/2026-04-22-comparison-live.md`
- `docs/bench/baseline.json` (measured state)

## Decisions held

1. Matcher strategy — evidenceTurns intersection. **Held.**
2. Empty-match semantics — NaN. **Held.**
3. Aggregation — nanmean with n_scored/n_skipped. **Held.**
4. Runner plumbing — sourceMessages passthrough. **Held.**
5. Scope — tests surgical rewrite. **Held.**
6. Scope — callers transparent. **Held.**
7. Preserved-but-deprecated old matchGold. **Held.**
8. Re-run scope — 4 sweeps + 3 baselines + ladder, warm cache. **Held.**
9. Baseline.json regeneration — absorbed into 9.4.6. **Held.**
10. Retro shape — this file, including shadow acknowledgement. **Held.**

## What worked

- Task 1 audit enumerated the exact call surface before any code touched — zero surprise callers.
- Task 3's wholesale test rewrite was cleaner than surgical patching of the existing file, which encoded the bug.
- Warm cache meant re-runs cost ~40 min of CPU and zero live LLM traffic.
- evidenceTurns intersection is deterministic and testable in a way text-Jaccard never was — unit tests assert exact set membership, not fuzzy thresholds.

## What surprised us

- [Fill in: elbow locations in 9.4.6 sweeps, whether baseline invariant passes, skip rate, anything unexpected]

## Notes for sub-phase 9.5 Tasks 6–10

- Sub-phase 9.5's original Tasks 5–10 are now conceptually done — 9.4.6 Task 4 re-ran all of them on honest metrics. The 9.5 plan's Task 11 (baseline.json) is done. Task 10 (new sweeps for TIER3_MAX_HOPS + EXPLICIT_RELATION_WEIGHT) remains open and can run on the same warm cache with 9.4.6 metrics.
- If the τ/graph/consolidation/bm25 sweeps show real elbows under 9.4.6 metrics (decisive Δmetric/Δknob), Phase 9's "specDefaults hold" conclusion is overturned. The elbow-derived tuning recommendations become the new proposal.
- n_skipped > 0 is now visible in every report. Any sweep where n_skipped > ~15% of total QAs should trigger a Phase 11 investigation: either the retriever is missing evidence (semantic gap) or the consolidation pipeline is losing source-message attribution somewhere.
- 9.5's `phase-9-5-live-extraction.md` plan is unaffected — its Tasks 1–4 (llmExtractor, cache, seeder switch, smoke) are still valid and committed. Mark its Tasks 5–10 as superseded by 9.4.6 in the 9.5 retro when it's written.

## Metrics

- Plan length: ~700 lines
- Duration: [fill in]
- Tests added: ~25 (Task 3 rewrite includes coverage for new matcher + NaN + n_scored)
- Tests changed/removed: 1 vacuous-case test deleted (the one that encoded the bug)
- Suite total after: [fill in]
- Files touched: 2 source (bench/metrics/retrieval.js, bench/runner.js), 2 test files, 5+ new docs, baseline.json regenerated

## Commit stack

```
[list commits]
```

Ready to close 9.4.6 and advance to 9.5 Task 10 (new-knob sweeps) or Phase 10.
```

**Step 2: Commit**

```bash
git add docs/plans/phase-9-4-6-retro.md
git commit -m "docs(plans): sub-phase 9.4.6 retro"
```

**Step 3: Final verification**

```bash
npm test
npm run lint
npm run typecheck
git log --oneline a4f164e..HEAD   # expect the 9.4.6 commit stack
```

---

## Done. 9.5 Tasks 6–10 are now largely superseded; Task 10 (new-knob sweeps) remains as the next open work.
